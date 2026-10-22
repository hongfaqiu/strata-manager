import { createContext, useContext } from 'react';

/** One ```html block chosen for the preview panel. `id` is the message id plus the block's place in the answer. */
export interface HtmlPreviewItem { id: string; code: string; title: string }
export interface HtmlPreviewHost { activeId?: string; open: (item: HtmlPreviewItem) => void }

/** Provided by the chat page, which owns the side panel; blocks only ask it to show their page. */
export const HtmlPreviewContext = createContext<HtmlPreviewHost | null>(null);
export const useHtmlPreviewHost = () => useContext(HtmlPreviewContext);
