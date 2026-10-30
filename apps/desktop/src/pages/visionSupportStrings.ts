import type { AppLanguage } from '@strata-manager/core';

// Strings for the image-support dialog (VisionSupportDialog.tsx). Order per key:
// zh-CN, en, zh-TW, ja, ko, de, fr, es, pt, ru.
type Row = [string, string, string, string, string, string, string, string, string, string];
const rows = {
  vsDeepseekLabel: ['图像输入', 'Image input', '圖像輸入', '画像入力', '이미지 입력', 'Bildeingabe', 'Entrée d’images', 'Entrada de imágenes', 'Entrada de imagens', 'Ввод изображений'],
  vsDeepseekHint: ['DeepSeek 自带读图，无需另选文件', 'DeepSeek reads images itself; no files to choose', 'DeepSeek 自帶讀圖，無需另選檔案', 'DeepSeek は自前で画像を読むため、ファイル選択は不要です', 'DeepSeek가 직접 이미지를 읽어 파일을 고를 필요가 없습니다', 'DeepSeek liest Bilder selbst, keine Dateien nötig', 'DeepSeek lit les images lui-même, aucun fichier à choisir', 'DeepSeek lee las imágenes por sí mismo; no hay archivos que elegir', 'O DeepSeek lê imagens sozinho; nenhum arquivo para escolher', 'DeepSeek сам читает изображения — файлы выбирать не нужно'],
  vsSave: ['保存', 'Save', '儲存', '保存', '저장', 'Speichern', 'Enregistrer', 'Guardar', 'Salvar', 'Сохранить'],
  vsSaveRestart: ['保存并重启', 'Save and restart', '儲存並重新啟動', '保存して再起動', '저장 후 재시작', 'Speichern und neu starten', 'Enregistrer et redémarrer', 'Guardar y reiniciar', 'Salvar e reiniciar', 'Сохранить и перезапустить'],
  vsRestartedOff: ['已重启，图像输入已关闭', 'Restarted with image input off', '已重新啟動，圖像輸入已關閉', '再起動しました。画像入力はオフです', '재시작했습니다. 이미지 입력이 꺼졌습니다', 'Neu gestartet, Bildeingabe ist aus', 'Redémarré, entrée d’images désactivée', 'Reiniciado con la entrada de imágenes desactivada', 'Reiniciado com a entrada de imagens desligada', 'Перезапущено, ввод изображений выключен'],
} satisfies Record<string, Row>;
export type VisionSupportTextKey = keyof typeof rows;
const codes: readonly AppLanguage[] = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru'];
export function visionSupportText(language: AppLanguage, key: VisionSupportTextKey): string {
  const index = codes.indexOf(language);
  return rows[key][index < 0 ? 1 : index]!;
}
