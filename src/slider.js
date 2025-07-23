import GObject from "gi://GObject";
import { QuickSlider } from "resource:///org/gnome/shell/ui/quickSettings.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import {
  getVCPInfoAsArray,
  executeDdcutilCommand,
  isVCPValid,
  parseVCPCurrentAndMax,
  WriteCollector,
} from "./utils.js";

export const DDCSliderItem = GObject.registerClass(
  class DDCSliderItem extends QuickSlider {
    _init(iconName, extension, vcpCodes, accessibleName) {
      super._init({
        iconName,
      });

      this.accessible_name = accessibleName;
      this._extension = extension;
      this._vcpCodes = vcpCodes;
      this._displays = [];
      this._currentVcpCode = null;

      this.slider.connect("notify::value", this._onSliderChanged.bind(this));

      // Initialize write collector
      this._writeCollector = new WriteCollector();
    }

    _onSliderChanged() {
      if (this._displays.length === 0) return;

      const sliderValue = this.slider.value;
      for (const display of this._displays) {
        const writer = async () => {
          const scaledValue = Math.round(sliderValue * 100);
          await this._extension._ddcSet(
            this._vcpCodes,
            scaledValue,
            display.bus,
          );
        };
        this._writeCollector.ddcWriteCollector(display.bus, writer);
      }

      this._changeSlider();
    }

    _changeSlider() {
      const brightness = Math.round(this.slider.value * 100);
      this.subtitle = `${brightness}%`;
    }

    setDisplays(displays) {
      this._displays = displays;
      this.visible = displays.length > 0;

      if (displays.length === 0) {
        this.subtitle = "";
        return;
      }

      // Check for contrast support if this is a brightness slider and the feature is enabled
      if (
        this._vcpCodes.includes("10") &&
        this._extension._settings.get_boolean("enable-contrast")
      ) {
        this._checkContrastSupport();
      } else {
        this._readCurrentValue();
      }
    }

    _checkContrastSupport() {
      if (this._displays.length === 0) return;

      const display = this._displays[0];
      executeDdcutilCommand(
        ["getvcp", "12", "--bus", display.bus, "--terse"],
        (stdout) => {
          if (stdout) {
            const vcpArray = getVCPInfoAsArray(stdout);
            if (isVCPValid(vcpArray)) {
              this._readContrastAndBrightness();
              return;
            }
          }
          this._readCurrentValue();
        },
      );
    }

    _readContrastAndBrightness() {
      if (this._displays.length === 0) return;

      const display = this._displays[0];
      let brightnessValue = null;
      let contrastValue = null;
      let completed = 0;

      const checkCompletion = () => {
        completed++;
        if (completed === 2) {
          if (brightnessValue !== null && contrastValue !== null) {
            const avgValue = (brightnessValue + contrastValue) / 2;
            this.slider.value = avgValue / 100;
            this._changeSlider();
          } else {
            this._readCurrentValue();
          }
        }
      };

      // Read brightness (VCP 10)
      this._readSingleVCP(display, "10", (value) => {
        brightnessValue = value;
        checkCompletion();
      });

      // Read contrast (VCP 12)
      this._readSingleVCP(display, "12", (value) => {
        contrastValue = value;
        checkCompletion();
      });
    }

    _readCurrentValue() {
      if (this._displays.length === 0) return;

      const display = this._displays[0];
      this._tryReadVCP(display, this._vcpCodes, 0);
    }

    _readSingleVCP(display, vcpCode, callback) {
      executeDdcutilCommand(
        ["getvcp", vcpCode, "--bus", display.bus, "--terse"],
        (stdout) => {
          if (stdout) {
            const vcpArray = getVCPInfoAsArray(stdout);
            const { current } = parseVCPCurrentAndMax(vcpArray);
            callback(current);
          } else {
            callback(null);
          }
        },
      );
    }

    _tryReadVCP(display, vcpCodes, codeIndex) {
      if (codeIndex >= vcpCodes.length) {
        logError(
          new Error(`Failed to read any VCP codes for display ${display.bus}`),
        );
        return;
      }

      const vcpCode = vcpCodes[codeIndex];
      executeDdcutilCommand(
        ["getvcp", vcpCode, "--bus", display.bus, "--terse"],
        (stdout) => {
          if (stdout) {
            const vcpArray = getVCPInfoAsArray(stdout);
            const { current, max } = parseVCPCurrentAndMax(vcpArray);

            if (current !== null && max !== null) {
              this._currentVcpCode = vcpCode;
              this.slider.value = current / max;
              this._changeSlider();
              return;
            }
          }

          // Try next VCP code
          this._tryReadVCP(display, vcpCodes, codeIndex + 1);
        },
      );
    }

    destroy() {
      if (this._writeCollector) {
        this._writeCollector.destroy();
        this._writeCollector = null;
      }
      super.destroy();
    }
  },
);
