/** sessionStorage key for the time of the last full workspace backup download in this tab. */
const LAST_BACKUP_KEY = 'aegis_last_backup';

/**
 * Saves text as a file through a temporary object URL. CSV files get a UTF-8 byte order mark so
 * Excel reads non-ASCII names correctly.
 */
export function downloadFile(filename: string, text: string, mime: 'application/json' | 'text/csv'): void {
  const body = mime === 'text/csv' ? `﻿${text}` : text;
  const type = mime === 'text/csv' ? 'text/csv;charset=utf-8' : 'application/json';
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Records that a full backup was just downloaded. Storage may be blocked, so failures are ignored. */
export function recordBackupTime(when: Date = new Date()): void {
  try {
    sessionStorage.setItem(LAST_BACKUP_KEY, when.toISOString());
  } catch {
    /* Unavailable storage: the reminder simply keeps showing. */
  }
}

/** Time of the last full backup download in this tab, or null if there was none. */
export function lastBackupTime(): Date | null {
  try {
    const raw = sessionStorage.getItem(LAST_BACKUP_KEY);
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}
