/**
 * Single keypress reader.
 *
 * Reads one keypress from stdin using raw mode. Used by the pager
 * and other interactive components. No external dependencies.
 */

/**
 * Read a single keypress from stdin.
 *
 * Enables raw mode, reads one character, restores original mode.
 * Returns an empty string on error or if stdin is not a TTY.
 *
 * Has a 30-second timeout to prevent hanging if stdin closes unexpectedly.
 *
 * Special key names:
 *   - 'return'  → Enter key
 *   - 'space'   → Space bar
 *   - 'escape'  → Escape key
 *   - 'up'      → Arrow Up
 *   - 'down'    → Arrow Down
 *   - 'ctrl-c'  → Ctrl+C (triggers SIGINT)
 *   - 'ctrl-d'  → Ctrl+D
 */
export async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) return '';

  const wasRaw = process.stdin.isRaw;
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return await new Promise<string>((resolve, reject) => {
      let cleanedUp = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('error', onError);
        process.stdin.removeListener('end', onEnd);
        clearTimeout(timeout);
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve('');
      }, 30_000);

      const onError = (err: Error) => {
        cleanup();
        resolve('');
      };

      const onEnd = () => {
        cleanup();
        resolve('');
      };

      const onData = (chunk: Buffer) => {
        cleanup();
        const byte = chunk[0];

        // Arrow keys and function keys send escape sequences
        if (byte === 0x1b && chunk.length > 1) {
          // ESC sequence
          if (chunk[1] === 0x5b) {
            // CSI sequence: ESC [
            switch (chunk[2]) {
              case 0x41: resolve('up'); return;
              case 0x42: resolve('down'); return;
              case 0x43: resolve('right'); return;
              case 0x44: resolve('left'); return;
              default: resolve('escape'); return;
            }
          }
          resolve('escape');
          return;
        }

        switch (byte) {
          case 0x0a: case 0x0d: resolve('return'); return;   // Enter
          case 0x20: resolve('space'); return;                // Space
          case 0x1b: resolve('escape'); return;               // Escape
          case 0x03: resolve('ctrl-c'); return;               // Ctrl+C
          case 0x04: resolve('ctrl-d'); return;               // Ctrl+D
          case 0x7f: resolve('backspace'); return;            // Backspace
          default: resolve(String(chunk)); return;            // Printable char
        }
      };

      process.stdin.on('data', onData);
      process.stdin.on('error', onError);
      process.stdin.on('end', onEnd);
    });
  } finally {
    process.stdin.setRawMode(wasRaw ?? false);
    if (!wasRaw) {
      process.stdin.pause();
    }
  }
}