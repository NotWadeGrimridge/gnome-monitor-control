# GNOME Monitor Control

Control external monitor brightness and volume using DDC.

## Installation

Clone the repository to your GNOME extensions directory:

```
git clone https://github.com/NotWadeGrimridge/gnome-monitor-control ~/.local/share/gnome-shell/extensions/gnome-ddcutil@wadegrimridge
```

Enable the extension:

```
gnome-extensions enable gnome-ddcutil@wadegrimridge
```

## Requirements

- `ddcutil`

```
sudo pacman -S ddcutil
```

## Features

- Brightness control slider in the Quick Settings panel
- Volume control slider for external monitors (when using monitor speakers)
- Automatic audio volume synchronization with system volume
- Contrast adjustment support
- Keyboard shortcuts for brightness adjustment
- On-screen display when adjusting brightness via keyboard
- Automatic detection of active external monitors
- Power state monitoring to show controls only for active displays

## Configuration

Access preferences through GNOME Extensions app or:

```
gnome-extensions prefs gnome-ddcutil@wadegrimridge
```

Available settings:

- Keyboard shortcut customization
- Step size for keyboard brightness adjustments
- Toggle on-screen display
- Enable/disable contrast control
- Enable/disable audio volume synchronization
