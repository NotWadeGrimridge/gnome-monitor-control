import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Meta from "gi://Meta";
import Shell from "gi://Shell";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { DDCSliderItem } from "./slider.js";
import {
  parseMonitorName,
  getVCPInfoAsArray,
  executeDdcutilCommand,
  executePactlCommand,
  extractAudioMonitorName,
  WriteCollector,
} from "./utils.js";

export default class GnomeDdcutil extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._writeCollector = new WriteCollector();
    this._activeDisplays = [];

    this._brightnessSlider = new DDCSliderItem(
      "display-brightness-symbolic",
      this,
      ["10", "6B"], // Try VCP 10 first, fallback to 6B
      "External Monitor Brightness",
    );

    this._volumeSlider = new DDCSliderItem(
      "audio-volume-high-symbolic",
      this,
      ["62"], // VCP 62 for volume
      "External Monitor Volume",
    );

    this._brightnessSlider.visible = false;
    this._volumeSlider.visible = false;

    this._detectDisplays();
    this._monitorAudioChanges();
    this._addKeyboardShortcuts();
    this._addSettingsListeners();

    // Add to QuickSettings menu
    const qsMenu = Main.panel.statusArea.quickSettings;

    const addToQuickSettings = () => {
      if (qsMenu._brightness) {
        qsMenu._addItemsBefore(
          [this._brightnessSlider, this._volumeSlider],
          qsMenu._brightness.quickSettingsItems.at(-1),
          2,
        );
      }
    };

    if (qsMenu._brightness) {
      addToQuickSettings();
    } else {
      // Wait for indicators to be available
      this._readyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        if (qsMenu._brightness) {
          addToQuickSettings();
          this._readyId = null;
          return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
      });
    }
  }

  async _ddcSet(vcpCodes, value, bus) {
    const codes = Array.isArray(vcpCodes) ? vcpCodes : [vcpCodes];
    // Try each VCP code until one succeeds
    for (const vcp of codes) {
      try {
        const ddcProc = Gio.Subprocess.new(
          [
            "ddcutil",
            "setvcp",
            "--bus",
            bus,
            "--noverify",
            vcp,
            value.toString(),
          ],
          Gio.SubprocessFlags.STDERR_SILENCE,
        );
        // eslint-disable-next-line no-await-in-loop -- intentional sequential fallback
        await ddcProc.wait_async(null);
        if (ddcProc.get_successful()) {
          return; // Success, no need to try other VCP codes
        }
      } catch (e) {
        logError(e, `DDC set failed for bus ${bus} with VCP ${vcp}`);
      }
    }
  }

  _detectDisplays() {
    executeDdcutilCommand(["detect", "--brief"], (stdout) => {
      if (stdout) {
        this._parseDisplays(stdout);
      } else {
        logError(new Error("DDC detection failed"));
      }
    });
  }

  _parseDisplays(output) {
    const lines = output.split("\n");
    let currentDisplay = null;
    const potentialDisplays = [];

    let skipCurrentDisplay = false;

    for (const line of lines) {
      if (line.includes("Invalid display")) {
        skipCurrentDisplay = true;
        continue;
      }

      if (line.includes("Display ")) {
        skipCurrentDisplay = false;
        continue;
      }

      if (skipCurrentDisplay) {
        continue;
      }

      if (line.includes("/dev/i2c-") && !line.includes("phantom")) {
        const busMatch = line.match(/\/dev\/i2c-(\d+)/);
        if (busMatch) {
          currentDisplay = { bus: busMatch[1] };
        }
      } else if (line.includes("Monitor:") && currentDisplay) {
        const fullName = line.split("Monitor:")[1].trim();
        currentDisplay.name = parseMonitorName(fullName);
        potentialDisplays.push(currentDisplay);
        currentDisplay = null;
      }
    }

    this._checkDisplayPowerStates(potentialDisplays);
  }

  _monitorAudioChanges() {
    try {
      this._pactlSubprocess = Gio.Subprocess.new(
        ["pactl", "subscribe"],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
      );

      const stdout = this._pactlSubprocess.get_stdout_pipe();
      const reader = new Gio.DataInputStream({
        base_stream: stdout,
      });

      this._readPactlEvents(reader);
    } catch (e) {
      logError(e, "Failed to start pactl subscribe");
    }
  }

  _readPactlEvents(reader) {
    reader.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
      try {
        const line = stream.read_line_finish_utf8(res)[0];
        if (line !== null) {
          if (line.includes("'change' on sink")) {
            this._handleVolumeChange();
          } else if (line.includes("on sink")) {
            this._detectDisplays();
          }
          this._readPactlEvents(reader);
        }
      } catch {
        // Process probably terminated
      }
    });
  }

  _handleVolumeChange() {
    // Check if audio sync feature is enabled
    if (!this._settings.get_boolean("enable-audio-sync")) {
      return;
    }

    // Add a small delay to ensure the new volume is readable
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
      this._getActiveAudioMonitorName((activeAudioMonitorName) => {
        const volumeDisplays = this._getVolumeDisplays(activeAudioMonitorName);
        this._syncVolume(volumeDisplays);
      });
      return GLib.SOURCE_REMOVE;
    });
  }

  _getVolumeDisplays(activeAudioMonitorName) {
    if (!activeAudioMonitorName) {
      return [];
    }
    return this._activeDisplays.filter(
      (d) => d.name && d.name.includes(activeAudioMonitorName),
    );
  }

  _updateVolumeSliderVisibility(activeAudioMonitorName) {
    // Show volume slider if:
    // 1. Audio sync is disabled (otherwise audio sync handles volume)
    // 2. Current audio device is a monitor
    const showVolumeSlider =
      !this._settings.get_boolean("enable-audio-sync") &&
      activeAudioMonitorName;

    if (showVolumeSlider) {
      const volumeDisplays = this._getVolumeDisplays(activeAudioMonitorName);
      this._volumeSlider.setDisplays(volumeDisplays);
    } else {
      this._volumeSlider.setDisplays([]);
    }
  }

  _syncVolume(volumeDisplays) {
    if (volumeDisplays.length === 0) return;

    this._getSystemVolume((systemVolume) => {
      if (systemVolume === null) return;
      for (const display of volumeDisplays) {
        const writer = async () => {
          await this._ddcSet(["62"], systemVolume, display.bus);
        };
        this._writeCollector.ddcWriteCollector(display.bus, writer);
      }
    });
  }

  _getSystemVolume(callback) {
    executePactlCommand(["get-sink-volume", "@DEFAULT_SINK@"], (stdout) => {
      if (stdout) {
        const match = stdout.match(/(\d+)%/);
        if (match && match[1]) {
          callback(parseInt(match[1], 10));
          return;
        }
      }
      callback(null);
    });
  }

  _getActiveAudioMonitorName(callback) {
    executePactlCommand(["get-default-sink"], (defaultSinkOutput) => {
      if (!defaultSinkOutput) {
        callback(null);
        return;
      }
      const defaultSink = defaultSinkOutput.trim();

      executePactlCommand(["list", "sinks"], (sinksOutput) => {
        if (!sinksOutput) {
          callback(null);
          return;
        }

        const sinkSections = sinksOutput.split("Sink #");
        for (const section of sinkSections) {
          const monitorName = extractAudioMonitorName(section, defaultSink);
          if (monitorName) {
            callback(monitorName);
            return;
          }
        }
        callback(null);
      });
    });
  }

  _checkDisplayPowerStates(potentialDisplays) {
    const activeDisplays = [];
    let pendingChecks = potentialDisplays.length;

    if (pendingChecks === 0) {
      this._activeDisplays = [];
      this._brightnessSlider.setDisplays([]);
      return;
    }

    this._getActiveAudioMonitorName((activeAudioMonitorName) => {
      const checkComplete = () => {
        pendingChecks--;
        if (pendingChecks === 0) {
          this._activeDisplays = activeDisplays;
          this._brightnessSlider.setDisplays(activeDisplays);

          this._updateVolumeSliderVisibility(activeAudioMonitorName);

          // Only sync volume if audio sync is enabled
          if (this._settings.get_boolean("enable-audio-sync")) {
            const volumeDisplays = this._getVolumeDisplays(
              activeAudioMonitorName,
            );
            this._syncVolume(volumeDisplays);
          }
        }
      };

      for (const display of potentialDisplays) {
        executeDdcutilCommand(
          ["getvcp", "D6", "--bus", display.bus, "--terse"],
          (stdout) => {
            if (stdout) {
              const vcpArray = getVCPInfoAsArray(stdout);
              // Check if display is on: VCP D6 (Power mode) should return x01 (DPM: On, DPMS: Off)
              if (vcpArray.length >= 4 && vcpArray[3] === "x01") {
                activeDisplays.push(display);
              }
            } else {
              // If power state check fails, assume display is active (conservative approach)
              activeDisplays.push(display);
            }
            checkComplete();
          },
        );
      }
    });
  }

  _addKeyboardShortcuts() {
    const shortcuts = [
      ["increase-brightness-shortcut", this._increaseBrightness.bind(this)],
      ["decrease-brightness-shortcut", this._decreaseBrightness.bind(this)],
    ];

    shortcuts.forEach(([key, handler]) => {
      Main.wm.addKeybinding(
        key,
        this._settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.ALL,
        handler,
      );
    });
  }

  _addSettingsListeners() {
    this._contrastSettingId = this._settings.connect(
      "changed::enable-contrast",
      () => {
        // Re-check contrast support when setting changes
        if (
          this._brightnessSlider &&
          this._brightnessSlider._displays.length > 0
        ) {
          this._brightnessSlider._checkContrastSupport();
        }
      },
    );

    this._audioSyncSettingId = this._settings.connect(
      "changed::enable-audio-sync",
      () => {
        // Update volume slider visibility when audio sync setting changes
        this._getActiveAudioMonitorName((activeAudioMonitorName) => {
          this._updateVolumeSliderVisibility(activeAudioMonitorName);
        });
      },
    );
  }

  _removeKeyboardShortcuts() {
    const shortcuts = [
      "increase-brightness-shortcut",
      "decrease-brightness-shortcut",
    ];
    shortcuts.forEach((key) => Main.wm.removeKeybinding(key));
  }

  _increaseBrightness() {
    this._adjustBrightness(true);
  }

  _decreaseBrightness() {
    this._adjustBrightness(false);
  }

  _adjustBrightness(increase) {
    if (!this._brightnessSlider.visible || this._activeDisplays.length === 0) {
      return;
    }

    const stepSize = this._settings.get_double("step-change-keyboard") / 100;
    const currentValue = this._brightnessSlider.slider.value;
    const newValue = increase
      ? Math.min(1.0, currentValue + stepSize)
      : Math.max(0.0, currentValue - stepSize);

    this._brightnessSlider.slider.value = newValue;

    // Show OSD if enabled
    if (this._settings.get_boolean("show-osd")) {
      const brightnessPercent = Math.round(newValue * 100);
      const displayLabel = this._getDisplayLabel();

      Main.osdWindowManager.show(
        -1,
        new Gio.ThemedIcon({ name: "display-brightness-symbolic" }),
        `${displayLabel} ${brightnessPercent}%`,
        newValue,
        1,
      );
    }
  }

  _getDisplayLabel() {
    if (this._activeDisplays.length === 1) {
      return this._activeDisplays[0].name || "External Monitor";
    } else if (this._activeDisplays.length > 1) {
      return `${this._activeDisplays.length} External Monitors`;
    }
    return "External Monitor";
  }

  disable() {
    if (this._readyId) {
      GLib.Source.remove(this._readyId);
      this._readyId = null;
    }

    if (this._pactlSubprocess) {
      this._pactlSubprocess.force_exit();
      this._pactlSubprocess = null;
    }

    if (this._writeCollector) {
      this._writeCollector.destroy();
      this._writeCollector = null;
    }

    if (this._brightnessSlider) {
      this._brightnessSlider.destroy();
      this._brightnessSlider = null;
    }

    if (this._volumeSlider) {
      this._volumeSlider.destroy();
      this._volumeSlider = null;
    }

    this._removeKeyboardShortcuts();

    if (this._contrastSettingId) {
      this._settings.disconnect(this._contrastSettingId);
      this._contrastSettingId = null;
    }

    if (this._audioSyncSettingId) {
      this._settings.disconnect(this._audioSyncSettingId);
      this._audioSyncSettingId = null;
    }

    this._settings = null;
  }
}
