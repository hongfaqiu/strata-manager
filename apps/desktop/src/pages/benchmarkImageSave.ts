import * as core from '@strata-manager/core';

type BrowserFileHandle = { name: string; createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }> };
type SavePickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<BrowserFileHandle> };

/** null means the user cancelled; no export is performed in that case. */
export async function saveBenchmarkPng(name: string, blob: Blob): Promise<string | null> {
  if (core.isDesktop()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const selected = await save({ defaultPath: name, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!selected) return null;
    const path = /\.png$/i.test(selected) ? selected : `${selected}.png`;
    return core.savePng(path, Array.from(new Uint8Array(await blob.arrayBuffer())));
  }
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (picker) {
    let handle: BrowserFileHandle;
    try { handle = await picker.call(window, { suggestedName: name, types: [{ description: 'PNG', accept: { 'image/png': ['.png'] } }] }); }
    catch (error) { if ((error as { name?: string })?.name === 'AbortError') return null; throw error; }
    const writer = await handle.createWritable();
    try { await writer.write(blob); await writer.close(); }
    catch (error) { try { await writer.abort(); } catch { /* Preserve the original write error. */ } throw error; }
    return handle.name;
  }
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
