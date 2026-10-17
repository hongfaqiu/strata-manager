import type { AppLanguage } from '@strata-manager/core';

// Strings added by the API usage redesign. Order: zh-CN, en, zh-TW, ja, ko, de, fr, es, pt, ru.
const rows = {
  periodHour: ['1 小时', '1 h', '1 小時', '1 時間', '1시간', '1 Std.', '1 h', '1 h', '1 h', '1 ч'],
  periodToday: ['今日', 'Today', '今日', '今日', '오늘', 'Heute', "Aujourd'hui", 'Hoy', 'Hoje', 'Сегодня'],
  periodDay: ['24 小时', '24 h', '24 小時', '24 時間', '24시간', '24 Std.', '24 h', '24 h', '24 h', '24 ч'],
  periodThreeDays: ['3 天', '3 d', '3 天', '3 日', '3일', '3 T.', '3 j', '3 d', '3 d', '3 дн.'],
  periodWeek: ['7 天', '7 d', '7 天', '7 日', '7일', '7 T.', '7 j', '7 d', '7 d', '7 дн.'],
  periodHistory: ['90 天', '90 d', '90 天', '90 日', '90일', '90 T.', '90 j', '90 d', '90 d', '90 дн.'],
  kpiRequests: ['请求', 'Requests', '請求', 'リクエスト', '요청', 'Anfragen', 'Requêtes', 'Solicitudes', 'Requisições', 'Запросы'],
  kpiFailures: ['失败', 'Failed', '失敗', '失敗', '실패', 'Fehlgeschlagen', 'Échecs', 'Fallidas', 'Falhas', 'Ошибки'],
  kpiSpeed: ['生成速度', 'Generation speed', '生成速度', '生成速度', '생성 속도', 'Generierung', 'Génération', 'Generación', 'Geração', 'Генерация'],
  kpiInput: ['输入 Token', 'Input tokens', '輸入 Token', '入力トークン', '입력 토큰', 'Eingabe-Token', "Jetons d'entrée", 'Tokens de entrada', 'Tokens de entrada', 'Входные токены'],
  kpiOutput: ['输出 Token', 'Output tokens', '輸出 Token', '出力トークン', '출력 토큰', 'Ausgabe-Token', 'Jetons de sortie', 'Tokens de salida', 'Tokens de saída', 'Выходные токены'],
  kpiSucceededOf: ['成功 {{count}}', '{{count}} succeeded', '成功 {{count}}', '成功 {{count}}', '성공 {{count}}', '{{count}} erfolgreich', '{{count}} réussies', '{{count}} correctas', '{{count}} com sucesso', 'Успешно: {{count}}'],
  kpiReused: ['缓存复用 {{value}}', '{{value}} from cache', '快取複用 {{value}}', 'キャッシュ再利用 {{value}}', '캐시 재사용 {{value}}', '{{value}} aus Cache', '{{value}} depuis le cache', '{{value}} desde caché', '{{value}} do cache', 'Из кэша: {{value}}'],
  kpiPerRequest: ['平均每次 {{value}}', '{{value}} per request', '平均每次 {{value}}', '1 回平均 {{value}}', '요청당 {{value}}', '{{value}} pro Anfrage', '{{value}} par requête', '{{value}} por solicitud', '{{value}} por requisição', '{{value}} на запрос'],
  trendTitle: ['趋势', 'Trends', '趨勢', '推移', '추이', 'Verlauf', 'Tendances', 'Tendencias', 'Tendências', 'Динамика'],
  trendMetric: ['趋势指标', 'Trend metric', '趨勢指標', '推移の指標', '추이 지표', 'Verlaufsmetrik', 'Métrique', 'Métrica', 'Métrica', 'Метрика'],
  trendRequests: ['请求', 'Requests', '請求', 'リクエスト', '요청', 'Anfragen', 'Requêtes', 'Solicitudes', 'Requisições', 'Запросы'],
  trendTokens: ['Token', 'Tokens', 'Token', 'トークン', '토큰', 'Token', 'Jetons', 'Tokens', 'Tokens', 'Токены'],
  trendLatency: ['耗时', 'Latency', '耗時', '所要時間', '지연', 'Latenz', 'Latence', 'Latencia', 'Latência', 'Задержка'],
  trendDecode: ['生成速度', 'Generation', '生成速度', '生成速度', '생성 속도', 'Generierung', 'Génération', 'Generación', 'Geração', 'Генерация'],
  trendPrefill: ['输入处理', 'Prefill', '輸入處理', '入力処理', '입력 처리', 'Prefill', 'Prefill', 'Prefill', 'Prefill', 'Prefill'],
  trendCache: ['缓存', 'Cache', '快取', 'キャッシュ', '캐시', 'Cache', 'Cache', 'Caché', 'Cache', 'Кэш'],
  outcomeTitle: ['请求结果', 'Outcomes', '請求結果', '結果', '요청 결과', 'Ergebnisse', 'Résultats', 'Resultados', 'Resultados', 'Результаты'],
  outcomeChart: ['请求结果占比', 'Share of request outcomes', '請求結果占比', '結果の内訳', '요청 결과 비율', 'Anteil der Ergebnisse', 'Répartition des résultats', 'Reparto de resultados', 'Distribuição dos resultados', 'Доля результатов'],
  sourcesTitle: ['调用来源', 'Callers', '呼叫來源', '呼び出し元', '호출 출처', 'Aufrufer', 'Appelants', 'Orígenes', 'Origens', 'Источники'],
  share: ['占比', 'Share', '占比', '割合', '비율', 'Anteil', 'Part', 'Proporción', 'Parcela', 'Доля'],
  sourceSuccess: ['成功率', 'Success', '成功率', '成功率', '성공률', 'Erfolg', 'Réussite', 'Éxito', 'Sucesso', 'Успех'],
  performanceTitle: ['响应速度', 'Response time', '回應速度', '応答時間', '응답 속도', 'Antwortzeit', 'Temps de réponse', 'Tiempo de respuesta', 'Tempo de resposta', 'Время ответа'],
  efficiencyTitle: ['缓存与推理', 'Cache and inference', '快取與推理', 'キャッシュと推論', '캐시와 추론', 'Cache und Inferenz', 'Cache et inférence', 'Caché e inferencia', 'Cache e inferência', 'Кэш и инференс'],
  notesTitle: ['统计说明与数据覆盖', 'Notes and data coverage', '統計說明與資料涵蓋', '集計の説明とデータ範囲', '통계 설명과 데이터 범위', 'Hinweise und Datenabdeckung', 'Notes et couverture', 'Notas y cobertura', 'Notas e cobertura', 'Пояснения и охват данных'],
  notesTabs: ['统计说明分类', 'Notes sections', '統計說明分類', '説明の区分', '설명 구분', 'Abschnitte', 'Sections', 'Secciones', 'Seções', 'Разделы'],
  samplesTab: ['有效样本', 'Samples', '有效樣本', '有効サンプル', '유효 샘플', 'Stichproben', 'Échantillons', 'Muestras', 'Amostras', 'Выборки'],
  emptyTitle: ['还没有 API 调用', 'No API calls yet', '還沒有 API 呼叫', 'まだ API 呼び出しはありません', '아직 API 호출이 없습니다', 'Noch keine API-Aufrufe', "Aucun appel d'API pour l'instant", 'Aún no hay llamadas a la API', 'Ainda sem chamadas à API', 'Вызовов API пока нет'],
} satisfies Record<string, readonly [string, string, string, string, string, string, string, string, string, string]>;

const codes = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru'] as const;
export type ApiUsageLayoutKey = keyof typeof rows;
export type ApiUsageLayoutText = Record<ApiUsageLayoutKey, string>;
export const apiUsageLayoutStrings: Record<string, ApiUsageLayoutText> = Object.fromEntries(codes.map((code, index) => [code, Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values[index]!])) as ApiUsageLayoutText]));
export const apiUsageLayoutText = (language: AppLanguage | string): ApiUsageLayoutText => apiUsageLayoutStrings[language] ?? apiUsageLayoutStrings.en!;
