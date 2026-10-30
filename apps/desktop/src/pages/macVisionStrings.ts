import type { AppLanguage } from '@strata-manager/core';

// The macOS-version notice in the image-support dialog. Order per key:
// zh-CN, en, zh-TW, ja, ko, de, fr, es, pt, ru. `{v}` is the required macOS version.
type Row = [string, string, string, string, string, string, string, string, string, string];
const rows = {
  mvTitle: ['图像输入需要 macOS {v}+', 'Image input needs macOS {v}+', '圖像輸入需要 macOS {v}+', '画像入力には macOS {v} 以降が必要です', '이미지 입력은 macOS {v} 이상이 필요합니다', 'Bildeingabe braucht macOS {v}+', 'L’entrée d’images requiert macOS {v}+', 'La entrada de imágenes requiere macOS {v}+', 'A entrada de imagens requer macOS {v}+', 'Для ввода изображений нужна macOS {v}+'],
  mvBody: ['当前读图组件无法在本机启动，文字对话不受影响。', 'The image reader can’t start on this Mac. Text chat still works.', '目前的讀圖元件無法在本機啟動，文字對話不受影響。', '現在の画像読み取りはこの Mac では起動できません。テキストの会話は使えます。', '현재 이미지 판독기는 이 Mac에서 시작할 수 없습니다. 텍스트 대화는 그대로 됩니다.', 'Der Bildleser startet auf diesem Mac nicht. Text-Chat funktioniert weiter.', 'Le lecteur d’images ne démarre pas sur ce Mac. Le chat texte fonctionne toujours.', 'El lector de imágenes no puede iniciarse en este Mac. El chat de texto sigue funcionando.', 'O leitor de imagens não inicia neste Mac. O chat de texto continua funcionando.', 'Модуль чтения изображений не запускается на этом Mac. Текстовый чат работает.'],
  mvThisMac: ['本机', 'This Mac', '本機', 'この Mac', '이 Mac', 'Dieser Mac', 'Ce Mac', 'Este Mac', 'Este Mac', 'Этот Mac'],
  mvNeeded: ['需要', 'Needed', '需要', '必要', '필요', 'Nötig', 'Requis', 'Necesario', 'Necessário', 'Нужно'],
} satisfies Record<string, Row>;
export type MacVisionTextKey = keyof typeof rows;
const codes: readonly AppLanguage[] = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru'];
export function macVisionText(language: AppLanguage, key: MacVisionTextKey, version = ''): string {
  const index = codes.indexOf(language);
  return rows[key][index < 0 ? 1 : index]!.replace('{v}', version);
}
/** "27.0" → "27"; "26.1" stays. */
export const shortMacVersion = (version: string) => version.replace(/\.0$/, '');
