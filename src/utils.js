import Gio from "gi://Gio";

// General parsing utilities
/**
 * Parse monitor name from full display name format
 *
 * @param {string} fullName - Full name in format "BRAND:Monitor Name:SerialNumber"
 * @returns {string} The extracted monitor name
 */
export function parseMonitorName(fullName) {
  // Extract middle part from format "BRAND:Monitor Name:SerialNumber"
  const nameParts = fullName.split(":");
  return nameParts.length >= 2 ? nameParts[1].trim() : fullName;
}

/**
 * Parse audio property from pactl output line
 *
 * @param {string} line - Line from pactl output
 * @param {string} property - Property name to extract
 * @returns {string|null} The property value or null
 */
export function parseAudioProperty(line, property) {
  if (!line.includes(property)) return null;
  const parts = line.split("=");
  if (parts.length <= 1) return null;
  return parts[1].trim().replace(/"/g, "");
}

/**
 * Extract audio monitor name from sink section
 *
 * @param {string} sinkSection - Sink section from pactl output
 * @param {string} defaultSink - Default sink name
 * @returns {string|null} The monitor name or null
 */
export function extractAudioMonitorName(sinkSection, defaultSink) {
  if (!sinkSection.includes(`Name: ${defaultSink}`)) return null;

  const lines = sinkSection.split("\n");
  let nick = null;
  let alsaName = null;

  for (const line of lines) {
    if (!nick) nick = parseAudioProperty(line, "node.nick");
    if (!alsaName) alsaName = parseAudioProperty(line, "alsa.name");
    if (nick && alsaName) break;
  }

  return nick || alsaName;
}

// DDC parsing utilities
/**
 * Parse VCP info from ddcutil output into array
 *
 * @param {string} val - Raw ddcutil output
 * @returns {string[]} Array of VCP values
 */
export function getVCPInfoAsArray(val) {
  const matched = val.trim().match(/^VCP.*$/gm);
  if (matched !== null) {
    return matched.at(-1).split(" ");
  } else {
    return [];
  }
}

/**
 * Parse VCP value from hex or decimal string
 *
 * @param {string} val - VCP value string
 * @returns {number} Parsed value or NaN
 */
export function parseVCPValue(val) {
  if (typeof val !== "string") {
    return NaN;
  }
  if (val.startsWith("x")) {
    return parseInt(val.substring(1), 16);
  }
  return parseInt(val, 10);
}

/**
 * Validate VCP array format
 *
 * @param {string[]} vcpArray - Array of VCP values
 * @returns {boolean} True if valid VCP format
 */
export function isVCPValid(vcpArray) {
  if (vcpArray.length < 5 || vcpArray[2] === "ERR") {
    return false;
  }

  // Volume VCP 62 format requires 7 elements for CNC format
  if (vcpArray[2] === "CNC") {
    return vcpArray.length >= 7;
  }

  return true;
}

/**
 * Parse current and max values from VCP array
 *
 * @param {string[]} vcpArray - Array of VCP values
 * @returns {{current: number|null, max: number|null}} Current and max values
 */
export function parseVCPCurrentAndMax(vcpArray) {
  if (!isVCPValid(vcpArray)) {
    return { current: null, max: null };
  }

  // Different VCP codes have different output formats
  let current, max;

  if (vcpArray.length >= 7 && vcpArray[2] === "CNC") {
    // Volume VCP 62 format: VCP 62 CNC x00 x64 x00 x32
    // Position: 0   1  2   3   4   5   6
    // max is at position 4, current is at position 6
    current = parseVCPValue(vcpArray[6]);
    max = parseVCPValue(vcpArray[4]);
  } else {
    // Standard format like brightness VCP 10: VCP 10 C 43 100
    // Position: 0   1  2 3  4
    // current is at position 3, max is at position 4
    current = parseVCPValue(vcpArray[3]);
    max = parseVCPValue(vcpArray[4]);
  }

  return {
    current: !isNaN(current) ? current : null,
    max: !isNaN(max) && max > 0 ? max : null,
  };
}

// Command execution utilities
/**
 * Execute ddcutil command asynchronously
 *
 * @param {string[]} args - Command arguments
 * @param {Function} callback - Callback function with stdout or null
 */
export function executeDdcutilCommand(args, callback) {
  try {
    const proc = Gio.Subprocess.new(
      ["ddcutil", ...args],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
    proc.communicate_utf8_async(null, null, (readProc, res) => {
      try {
        const [, stdout] = readProc.communicate_utf8_finish(res);
        callback(readProc.get_successful() ? stdout : null);
      } catch {
        callback(null);
      }
    });
  } catch {
    callback(null);
  }
}

/**
 * Execute pactl command asynchronously
 *
 * @param {string[]} args - Command arguments
 * @param {Function} callback - Callback function with stdout or null
 */
export function executePactlCommand(args, callback) {
  try {
    const proc = Gio.Subprocess.new(
      ["pactl", ...args],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
    proc.communicate_utf8_async(null, null, (readProc, res) => {
      try {
        const [, stdout] = readProc.communicate_utf8_finish(res);
        callback(readProc.get_successful() ? stdout : null);
      } catch {
        callback(null);
      }
    });
  } catch {
    callback(null);
  }
}

// DDC Write management class
export class WriteCollector {
  constructor() {
    this.collection = {};
    this.DDC_WRITE_DELAY = 130; // ms delay for ddcutil
  }

  ddcWriteInQueue(displayBus) {
    if (this.collection[displayBus].interval == null) {
      this.collection[displayBus].interval = setInterval(async () => {
        if (this.collection[displayBus].countdown === 0) {
          await this.collection[displayBus].writer();
          clearInterval(this.collection[displayBus].interval);
          this.collection[displayBus].interval = null;
          this.collection[displayBus].countdown = this.DDC_WRITE_DELAY;
        } else {
          this.collection[displayBus].countdown -= 1;
        }
      }, 1);
    }
  }

  ddcWriteCollector(displayBus, writer) {
    if (displayBus in this.collection) {
      // Always update to the latest writer - this ensures we write the most recent value
      this.collection[displayBus].writer = writer;
      // Reset countdown to ensure we wait the full delay with the new value
      this.collection[displayBus].countdown = this.DDC_WRITE_DELAY;
      // Ensure the queue is running
      this.ddcWriteInQueue(displayBus);
    } else {
      // Define new display and add to queue
      this.collection[displayBus] = {
        countdown: this.DDC_WRITE_DELAY,
        interval: null,
        writer,
      };
      this.ddcWriteInQueue(displayBus);
    }
  }

  destroy() {
    Object.keys(this.collection).forEach((bus) => {
      if (this.collection[bus].interval !== null) {
        clearInterval(this.collection[bus].interval);
      }
    });
    this.collection = {};
  }
}
