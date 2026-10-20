import { describe, expect, it } from 'vitest';
import { formatStorageBytes, storageMoveFits, storageMoveMessage, storageMoveProgress, storageVolumeLabel } from '../src/storage-location';

describe('storage locations', () => {
  it('formats decimal sizes like the model catalog', () => {
    expect(formatStorageBytes(undefined)).toBe('—');
    expect(formatStorageBytes(512e6)).toBe('512 MB');
    expect(formatStorageBytes(3.254e9)).toBe('3.25 GB');
    expect(formatStorageBytes(82.44e9)).toBe('82.4 GB');
    expect(formatStorageBytes(1_234e9)).toBe('1,234 GB');
  });
  it('labels the drive or mount', () => {
    expect(storageVolumeLabel({ path: 'd:\\Strata-data' })).toBe('D:');
    expect(storageVolumeLabel({ path: '/mnt/data/Strata-data', mountPoint: '/mnt/data' })).toBe('/mnt/data');
    expect(storageVolumeLabel({ path: '/home/me/Strata-data' })).toBe('/');
  });
  it('reads the percent from move task messages', () => {
    expect(storageMoveProgress('正在复制模型文件 / Copying model files：1.23 GiB / 2.10 GiB（58%）· 120 MiB/s')).toBe(58);
    expect(storageMoveProgress('Copying 1 GiB / 2 GiB (7%)')).toBe(7);
    expect(storageMoveProgress('正在准备')).toBeUndefined();
  });
  it('keeps one GiB spare on another drive and ignores space on the same drive', () => {
    expect(storageMoveFits(80e9, { availableBytes: 82e9 }, false)).toBe(true);
    expect(storageMoveFits(80e9, { availableBytes: 80.5e9 }, false)).toBe(false);
    expect(storageMoveFits(80e9, { availableBytes: 1e9 }, true)).toBe(true);
    expect(storageMoveFits(0, { availableBytes: 0 }, false)).toBe(true);
  });
});

describe('storage move messages', () => {
  it('shows one language and keeps the amount', () => {
    const message = '正在复制模型文件 / Copying model files：1.23 GiB / 2.10 GiB（58%）· 120 MiB/s';
    expect(storageMoveMessage(message, true)).toBe('正在复制模型文件：1.23 GiB / 2.10 GiB（58%）· 120 MiB/s');
    expect(storageMoveMessage(message, false)).toBe('Copying model files: 1.23 GiB / 2.10 GiB（58%）· 120 MiB/s');
    expect(storageMoveMessage('正在更新模型配置里的文件路径 / Updating paths in run configurations', false)).toBe('Updating paths in run configurations');
    expect(storageMoveMessage(undefined, true)).toBe('');
  });
});
