import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";
import GObject from "gi://GObject";
import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { MonitorWadeShortcutWidget } from "./shortcut.js";

const PrefsWidget = GObject.registerClass(
  {
    GTypeName: "MonitorWadePrefsWidget",
  },
  class PrefsWidget extends Adw.PreferencesPage {
    _init(settings) {
      super._init({
        title: _("Preferences"),
        icon_name: "preferences-system-symbolic",
      });

      this._settings = settings;

      // Keyboard shortcuts group
      const shortcutsGroup = new Adw.PreferencesGroup({
        title: _("Keyboard Shortcuts"),
      });
      this.add(shortcutsGroup);

      // Create shortcut rows
      const increaseRow = this._createShortcutRow(
        "increase-brightness-shortcut",
        _("Increase Brightness"),
        _("Shortcut to increase external monitor brightness"),
      );
      shortcutsGroup.add(increaseRow);

      const decreaseRow = this._createShortcutRow(
        "decrease-brightness-shortcut",
        _("Decrease Brightness"),
        _("Shortcut to decrease external monitor brightness"),
      );
      shortcutsGroup.add(decreaseRow);

      // Step size row
      const stepAdjustment = new Gtk.Adjustment({
        lower: 1,
        upper: 100,
        step_increment: 1,
        page_increment: 5,
        value: this._settings.get_double("step-change-keyboard"),
      });

      const stepRow = new Adw.SpinRow({
        title: _("Keyboard Step Size"),
        subtitle: _("Percentage change when using keyboard shortcuts"),
        adjustment: stepAdjustment,
      });

      stepRow.connect("changed", () => {
        this._settings.set_double("step-change-keyboard", stepRow.get_value());
      });

      this._settings.connect("changed::step-change-keyboard", () => {
        stepRow.set_value(this._settings.get_double("step-change-keyboard"));
      });

      shortcutsGroup.add(stepRow);

      // Show OSD row
      const osdRow = new Adw.SwitchRow({
        title: _("Show On-Screen Display"),
        subtitle: _("Show brightness popup when using keyboard shortcuts"),
      });

      this._settings.bind(
        "show-osd",
        osdRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );

      shortcutsGroup.add(osdRow);

      // Features group
      const featuresGroup = new Adw.PreferencesGroup({
        title: _("Features"),
      });
      this.add(featuresGroup);

      // Contrast feature toggle
      const contrastRow = new Adw.SwitchRow({
        title: _("Enable Contrast Control"),
        subtitle: _(
          "Use brightness slider to control both brightness and contrast",
        ),
      });

      this._settings.bind(
        "enable-contrast",
        contrastRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );

      featuresGroup.add(contrastRow);

      // Audio sync toggle
      const audioSyncRow = new Adw.SwitchRow({
        title: _("Enable Audio Sync"),
        subtitle: _("Sync monitor volume with system audio volume"),
      });

      this._settings.bind(
        "enable-audio-sync",
        audioSyncRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );

      featuresGroup.add(audioSyncRow);
    }

    _createShortcutRow(settingKey, title, subtitle) {
      const row = new Adw.ActionRow({ title, subtitle });
      const widget = new MonitorWadeShortcutWidget();

      // Setup bindings
      this._settings.connect(`changed::${settingKey}`, () => {
        widget.keybinding = this._settings.get_strv(settingKey)[0];
      });
      widget.connect("notify::keybinding", () => {
        this._settings.set_strv(settingKey, [widget.keybinding]);
      });
      widget.keybinding = this._settings.get_strv(settingKey)[0];

      row.add_suffix(widget);
      return row;
    }
  },
);

export default class GnomeDdcutilPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    window.set_size_request(500, 600);
    window.search_enabled = true;

    window.add(new PrefsWidget(settings));
  }
}
