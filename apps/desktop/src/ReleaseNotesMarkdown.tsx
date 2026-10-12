import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createReleaseNotesAssetResolver } from './releaseNotesAssets';

// Import only the screenshots used by these release notes, including offline image links.
const screenshotModules = import.meta.glob<string>([
  '../../../docs/screenshots/benchmark.zh.webp',
  '../../../docs/screenshots/benchmark.en.webp',
  '../../../docs/screenshots/common-chat-settings.zh.webp',
  '../../../docs/screenshots/common-chat-settings.en.webp',
  '../../../docs/screenshots/connections.zh.webp',
  '../../../docs/screenshots/connections.en.webp',
  '../../../docs/screenshots/runtime-tools.zh.webp',
  '../../../docs/screenshots/runtime-tools.en.webp',
  '../../../docs/screenshots/runtime-download-settings.zh.webp',
  '../../../docs/screenshots/runtime-download-settings.en.webp',
  '../../../docs/screenshots/service-status.zh.webp',
  '../../../docs/screenshots/service-status.en.webp',
  '../../../docs/screenshots/floating-monitor.zh.webp',
  '../../../docs/screenshots/floating-monitor.en.webp',
  '../../../docs/screenshots/app-updates.zh.webp',
  '../../../docs/screenshots/app-updates.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/benchmark.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/benchmark.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/benchmark-report.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/benchmark-report.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/scenario-benchmark.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/scenario-benchmark.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/common-chat-settings.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/common-chat-settings.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/connections.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/connections.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/app-updates.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/app-updates.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/service-status.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/service-status.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/runtime-download.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/runtime-download.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/floating-monitor.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/floating-monitor.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/floating-monitor-settings.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/floating-monitor-settings.en.webp',
  '../../../docs/screenshots/changelog/0.1.5/overview-api-guide.zh.webp',
  '../../../docs/screenshots/changelog/0.1.5/overview-api-guide.en.webp',
], { eager: true, query: '?url&no-inline', import: 'default' });
const resolveAsset = createReleaseNotesAssetResolver(Object.fromEntries(
  Object.entries(screenshotModules).map(([path, url]) => [path.replace(/^\.\.\/\.\.\/\.\.\//, ''), url]),
));
const urlTransform = (url: string) => resolveAsset(defaultUrlTransform(url));
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer"/>,
  img: ({ node: _node, src, ...props }) => src
    ? <img {...props} src={src} loading="lazy" decoding="async"/>
    : <span>{props.alt}</span>,
};
const remarkPlugins = [remarkGfm];

export function ReleaseNotesMarkdown({ children }: { children: string }) {
  return <ReactMarkdown skipHtml remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>{children}</ReactMarkdown>;
}
