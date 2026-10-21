/**
 * Registro mínimo de métricas no formato de exposição do Prometheus
 * (text/plain; version=0.0.4). Sem dependências externas.
 *
 * Suporta counter, gauge e histogram com labels, além de "collectors"
 * assíncronos executados a cada scrape (ex.: contagens no banco).
 */

export type Labels = Record<string, string | number>;

type Series<T> = Map<string, { labels: Labels; value: T }>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`)
    .join(',');
}

/** Labels em ordem canônica: a mesma série renderiza sempre igual. */
function sortLabels(labels: Labels): Labels {
  return Object.fromEntries(Object.keys(labels).sort().map((k) => [k, labels[k]]));
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Labels, extra: Labels = {}): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all);

  if (keys.length === 0) {
    return '';
  }

  return `{${keys.map((k) => `${k}="${escapeLabelValue(String(all[k]))}"`).join(',')}}`;
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
      throw new Error(`Nome de métrica inválido: ${name}`);
    }
  }

  header(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract lines(): string[];
}

export class Counter extends Metric {
  private readonly series: Series<number> = new Map();

  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }

  inc(labels: Labels = {}, value = 1): void {
    if (value < 0) {
      throw new Error('Counter só pode aumentar.');
    }
    const key = labelKey(labels);
    const current = this.series.get(key);
    this.series.set(key, { labels: sortLabels(labels), value: (current?.value ?? 0) + value });
  }

  get(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  lines(): string[] {
    return [...this.series.values()].map(
      (s) => `${this.name}${formatLabels(s.labels)} ${formatNumber(s.value)}`,
    );
  }
}

export class Gauge extends Metric {
  private readonly series: Series<number> = new Map();

  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }

  set(labels: Labels, value: number): void {
    this.series.set(labelKey(labels), { labels: sortLabels(labels), value });
  }

  get(labels: Labels = {}): number | undefined {
    return this.series.get(labelKey(labels))?.value;
  }

  lines(): string[] {
    return [...this.series.values()].map(
      (s) => `${this.name}${formatLabels(s.labels)} ${formatNumber(s.value)}`,
    );
  }
}

export class Histogram extends Metric {
  private readonly series: Series<{ counts: number[]; sum: number; count: number }> = new Map();

  constructor(
    name: string,
    help: string,
    readonly buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {
    super(name, help, 'histogram');
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    const entry =
      this.series.get(key) ??
      { labels: sortLabels(labels), value: { counts: this.buckets.map(() => 0), sum: 0, count: 0 } };

    this.buckets.forEach((bound, i) => {
      if (value <= bound) {
        entry.value.counts[i] += 1;
      }
    });
    entry.value.sum += value;
    entry.value.count += 1;
    this.series.set(key, entry);
  }

  lines(): string[] {
    const out: string[] = [];

    for (const { labels, value } of this.series.values()) {
      this.buckets.forEach((bound, i) => {
        out.push(
          `${this.name}_bucket${formatLabels(labels, { le: formatNumber(bound) })} ${value.counts[i]}`,
        );
      });
      out.push(`${this.name}_bucket${formatLabels(labels, { le: '+Inf' })} ${value.count}`);
      out.push(`${this.name}_sum${formatLabels(labels)} ${formatNumber(value.sum)}`);
      out.push(`${this.name}_count${formatLabels(labels)} ${value.count}`);
    }

    return out;
  }
}

export type Collector = () => Promise<void> | void;

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: Collector[] = [];

  counter(name: string, help: string): Counter {
    return this.register(new Counter(name, help));
  }

  gauge(name: string, help: string): Gauge {
    return this.register(new Gauge(name, help));
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    return this.register(new Histogram(name, help, buckets));
  }

  /** Executado antes de cada render (ex.: atualizar gauges a partir do banco). */
  addCollector(collector: Collector): void {
    this.collectors.push(collector);
  }

  async render(): Promise<string> {
    // Um collector com falha não derruba o endpoint inteiro.
    await Promise.allSettled(this.collectors.map(async (c) => c()));

    const blocks: string[] = [];
    for (const metric of this.metrics.values()) {
      blocks.push([...metric.header(), ...metric.lines()].join('\n'));
    }
    return `${blocks.join('\n')}\n`;
  }

  private register<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Métrica duplicada: ${metric.name}`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }
}
