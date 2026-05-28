import type { ProjectFile, SubsystemFile } from '@procsim/file-format';
import { saveSubsystemFile } from '@procsim/file-format';

// Phase 11 — saves now use the `.cala` extension (the tool's brand name).
// `.procsim` is still accepted on load for files saved by earlier builds;
// the on-disk JSON format is unchanged, only the extension and MIME hint differ.
export const PROJECT_FILE_EXTENSION = '.cala';
export const PROJECT_FILE_LEGACY_EXTENSION = '.procsim';

// Upper bounds on file size at the picker layer. The check fires before any
// FileReader read so a wrong-file pick (e.g. a multi-GB ISO) fails cleanly
// instead of OOM'ing the tab. Limits are generous — a real .cala project
// rarely exceeds a few hundred KB, and real .xlsx / .pptx imports are well
// under tens of MB.
export const MAX_TEXT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_BINARY_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Predicate used by every file picker before invoking `FileReader`. Pure
 * function on `{ size }` so it's testable without a DOM. Returns `null`
 * when the size is within bounds, or a user-facing error string otherwise.
 */
export function validateFileSize(file: { size: number }, max: number): string | null {
  if (file.size <= max) return null;
  const formatMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
  return `File too large (${formatMb(file.size)} MB). Maximum is ${formatMb(max)} MB.`;
}

export function downloadProjectFile(project: ProjectFile): void {
  const filename =
    project.project.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + PROJECT_FILE_EXTENSION;
  const content = JSON.stringify(project, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function pickAndReadFile(): Promise<
  { ok: true; content: string } | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Accept the new `.cala` extension and the legacy `.procsim` extension;
    // both are valid project files on the load side.
    input.accept = `${PROJECT_FILE_EXTENSION},${PROJECT_FILE_LEGACY_EXTENSION},application/json`;

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({ ok: false, error: 'No file selected.' });
        return;
      }
      const sizeError = validateFileSize(file, MAX_TEXT_FILE_BYTES);
      if (sizeError !== null) {
        resolve({ ok: false, error: sizeError });
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result;
        if (typeof text !== 'string') {
          resolve({ ok: false, error: 'Could not read file.' });
          return;
        }
        resolve({ ok: true, content: text });
      };
      reader.onerror = () => resolve({ ok: false, error: 'Error reading file.' });
      reader.readAsText(file);
    };

    // Treat the dialog being closed without a selection as a cancellation.
    input.addEventListener('cancel', () => resolve({ ok: false, error: '' }));

    input.click();
  });
}

/**
 * Open a native file picker that returns the chosen file as ArrayBuffer + metadata.
 * Used for binary import formats (Excel, PPTX) and binary-capable XML reads.
 */
export async function pickAndReadBinaryFile(
  accept: string,
): Promise<
  { ok: true; buffer: ArrayBuffer; fileName: string; ext: string } | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({ ok: false, error: 'No file selected.' });
        return;
      }
      const sizeError = validateFileSize(file, MAX_BINARY_FILE_BYTES);
      if (sizeError !== null) {
        resolve({ ok: false, error: sizeError });
        return;
      }
      const ext = file.name.includes('.')
        ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
        : '';
      const reader = new FileReader();
      reader.onload = (ev) => {
        const result = ev.target?.result;
        if (!(result instanceof ArrayBuffer)) {
          resolve({ ok: false, error: 'Could not read file as binary.' });
          return;
        }
        resolve({ ok: true, buffer: result, fileName: file.name, ext });
      };
      reader.onerror = () => resolve({ ok: false, error: 'Error reading file.' });
      reader.readAsArrayBuffer(file);
    };

    input.addEventListener('cancel', () => resolve({ ok: false, error: '' }));
    input.click();
  });
}

// ── Sub-system file (.calasub) ────────────────────────────────────────────────

/** Phase 12 — extension for stand-alone sub-system files. */
export const SUBSYSTEM_FILE_EXTENSION = '.calasub';

/** Download a `.calasub` file whose base name comes from the sub-system name. */
export function downloadSubsystemFile(subsystem: SubsystemFile): void {
  const filename =
    subsystem.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + SUBSYSTEM_FILE_EXTENSION;
  const content = saveSubsystemFile(subsystem);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Open a native file picker that accepts `.calasub` files.
 * Returns the raw file contents and the original file name.
 */
export async function pickAndReadSubsystemFile(): Promise<
  { ok: true; content: string; fileName: string } | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = SUBSYSTEM_FILE_EXTENSION + ',application/json';

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({ ok: false, error: 'No file selected.' });
        return;
      }
      const sizeError = validateFileSize(file, MAX_TEXT_FILE_BYTES);
      if (sizeError !== null) {
        resolve({ ok: false, error: sizeError });
        return;
      }
      const fileName = file.name;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result;
        if (typeof text !== 'string') {
          resolve({ ok: false, error: 'Could not read file.' });
          return;
        }
        resolve({ ok: true, content: text, fileName });
      };
      reader.onerror = () => resolve({ ok: false, error: 'Error reading file.' });
      reader.readAsText(file);
    };

    input.addEventListener('cancel', () => resolve({ ok: false, error: '' }));
    input.click();
  });
}

/**
 * Compute a SHA-256 hex digest of a UTF-8 string.
 * Uses the Web Crypto API (available in all modern browsers and workers).
 */
export async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
