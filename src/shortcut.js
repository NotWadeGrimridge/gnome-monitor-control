import Gdk from "gi://Gdk";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

function isBindingValid({ mask, keyval }) {
  // Don't allow single modifier keys
  if (keyval >= Gdk.KEY_Shift_L && keyval <= Gdk.KEY_Hyper_R) {
    return false;
  }

  // Must have at least one modifier
  return mask !== 0;
}

function isAccelValid({ mask, keyval }) {
  // Check for reserved combinations
  if (keyval === Gdk.KEY_Tab && mask & Gdk.ModifierType.ALT_MASK) {
    return false;
  }

  return Gtk.accelerator_valid(keyval, mask);
}

export const MonitorWadeShortcutWidget = GObject.registerClass(
  {
    GTypeName: "MonitorWadeShortcutWidget",
    Properties: {
      keybinding: GObject.ParamSpec.string(
        "keybinding",
        "Keybinding",
        "Key sequence",
        GObject.ParamFlags.READWRITE,
        null,
      ),
    },
  },
  class MonitorWadeShortcutWidget extends Gtk.Stack {
    _init() {
      super._init({
        hhomogeneous: false,
        valign: Gtk.Align.CENTER,
      });

      this.connect("notify::keybinding", this._onKeybindingChanged.bind(this));

      // Set button page
      const setButton = new Gtk.Button({
        label: _("Set Shortcut…"),
      });
      setButton.connect("clicked", this._onSetButtonClicked.bind(this));
      this.add_named(setButton, "set");

      // Edit page
      const editBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
      });

      this._shortcutLabel = new Gtk.ShortcutLabel();
      this._shortcutLabel.bind_property(
        "accelerator",
        this,
        "keybinding",
        GObject.BindingFlags.BIDIRECTIONAL,
      );
      this._shortcutLabel.add_css_class("flat");
      editBox.append(this._shortcutLabel);

      const clearButton = new Gtk.Button({
        icon_name: "edit-clear-symbolic",
      });
      clearButton.add_css_class("flat");
      clearButton.connect("clicked", this._onClearButtonClicked.bind(this));
      editBox.append(clearButton);

      this.add_named(editBox, "edit");

      // Dialog for capturing shortcuts
      this._dialog = new Gtk.Window({
        modal: true,
        hide_on_close: true,
        default_width: 400,
        title: _("Add Custom Shortcut"),
      });

      const headerBar = new Gtk.HeaderBar({
        show_title_buttons: false,
      });
      this._dialog.set_titlebar(headerBar);

      const dialogBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
        spacing: 12,
      });

      this._shortcutInfoLabel = new Gtk.Label({
        label: _("Enter the new shortcut"),
      });
      dialogBox.append(this._shortcutInfoLabel);

      const keyboardIcon = new Gtk.Image({
        icon_name: "input-keyboard-symbolic",
        pixel_size: 128,
      });
      dialogBox.append(keyboardIcon);

      const escapeLabel = new Gtk.Label({
        label: _("Press Esc to cancel the keyboard shortcut."),
      });
      dialogBox.append(escapeLabel);

      this._dialog.set_child(dialogBox);

      // Key event controller
      const keyController = new Gtk.EventControllerKey();
      keyController.connect("key-pressed", this._onKeyPressed.bind(this));
      this._dialog.add_controller(keyController);
    }

    _onKeybindingChanged() {
      this.visible_child_name = this.keybinding ? "edit" : "set";
    }

    _onSetButtonClicked() {
      this._shortcutInfoLabel.set_text(_("Enter the new shortcut"));
      this._dialog.set_transient_for(this.get_root());
      this._dialog.present();
    }

    _onClearButtonClicked() {
      this.keybinding = "";
    }

    _onKeyPressed(_widget, keyval, keycode, state) {
      let mask = state & Gtk.accelerator_get_default_mod_mask();
      mask &= ~Gdk.ModifierType.LOCK_MASK;

      if (keyval === Gdk.KEY_Escape) {
        this._dialog.close();
        return Gdk.EVENT_STOP;
      }

      if (
        !isBindingValid({ mask, keyval }) ||
        !isAccelValid({ mask, keyval })
      ) {
        this._shortcutInfoLabel.set_text(_("Reserved or invalid binding"));
        return Gdk.EVENT_STOP;
      }

      this.keybinding = Gtk.accelerator_name_with_keycode(
        null,
        keyval,
        keycode,
        mask,
      );

      this._dialog.close();

      return Gdk.EVENT_STOP;
    }
  },
);
