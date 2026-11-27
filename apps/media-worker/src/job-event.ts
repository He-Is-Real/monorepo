import {
  type Outcome,
  runWithEvent,
  startEvent,
  type WideEvent,
  writeErrorLine,
} from '@heisreal/logging/event';
import type { CheckResult } from './bunny';
import type { RenderResult } from './render';
import type { Delivery, JobDeps, LogEntry } from './worker';
import type { WriterReply } from './writer';

/**
 * The worker's one wide event per job (`event: "job"`; the writing-logs skill, LG-2 C and LG-4 A):
 * started when Dapr hands a delivery over, written once when the worker has answered Dapr. It
 * holds the job's ids, each step with its time and how it went (`job.steps`: Bunny's check, each
 * call to the result writer, the render), the picture video's size, where the message went
 * (`job.delivery`) and the outcome. Its `ref` is a new trace id: the worker sends it to the result
 * writer as `traceparent`, so the writer's events for the job carry the same `ref`.
 *
 * Ids, sizes and short codes only: never a pass, a link or a key.
 */

export interface JobStep {
  name: string;
  ms: number;
  outcome: string;
  status?: number;
  code?: string;
}

/** How a step's answer from the writer went. */
function writerOutcome(reply: WriterReply): Omit<JobStep, 'name' | 'ms'> {
  if (typeof reply === 'string') return { outcome: reply };
  const { status } = reply;
  const outcome =
    status < 300
      ? 'ok'
      : status === 404
        ? 'not_found'
        : status === 400
          ? 'input_refused'
          : 'error';
  return { outcome, status };
}

/** The job's outcome from its last step (worker.ts `done`). */
export function jobOutcome(entry: LogEntry): Outcome {
  if (entry.step === 'unreadable') return 'input_refused';
  if (entry.step === 'failed' || entry.code === 'failed') return 'error';
  if (entry.status === 404) return 'not_found';
  // The writer couldn't be reached or answered 5xx: the job goes back to the queue, or, its
  // tries used (worker.ts SendBacks), is marked taken for the 18:00 resend.
  if (entry.status !== undefined && entry.delivery !== 'SUCCESS')
    return 'error';
  return 'ok';
}

export function jobEvent(deps: Omit<JobDeps, 'log'>): {
  deps: JobDeps;
  run<T>(work: () => Promise<T>): Promise<T>;
  write(): void;
  crashed(err: unknown): void;
} {
  const event: WideEvent = startEvent('job', 'media-worker');
  const steps: JobStep[] = [];
  let name = 'media';

  const step = async <T>(
    stepName: string,
    work: () => Promise<T>,
    how: (result: T) => Omit<JobStep, 'name' | 'ms'>,
  ): Promise<T> => {
    const start = performance.now();
    try {
      const result = await work();
      steps.push({
        name: stepName,
        ms: Math.round(performance.now() - start),
        ...how(result),
      });
      return result;
    } catch (err) {
      steps.push({
        name: stepName,
        ms: Math.round(performance.now() - start),
        outcome: 'error',
        code: err instanceof Error ? err.name : 'error',
      });
      throw err;
    }
  };

  const log = (entry: LogEntry) => {
    if (entry.kind) name = `media.${entry.kind}`;
    const outcome = jobOutcome(entry);
    event.set({
      job: {
        id: entry.job,
        name,
        video_id: entry.video,
        event_id: entry.event,
        step: entry.step,
        code: entry.code,
        status: entry.status,
        delivery: entry.delivery,
      },
    });
    if (outcome === 'ok') event.setOutcome('ok');
    else {
      event.fail(
        {
          type: 'media_job',
          code:
            entry.code ?? (entry.status ? String(entry.status) : entry.step),
          retriable: entry.delivery === 'RETRY',
        },
        outcome,
      );
    }
  };

  const jobDeps: JobDeps = {
    ...deps,
    log,
    check: (video) =>
      step<CheckResult>(
        'check',
        () => deps.check(video),
        (r) =>
          'failure' in r
            ? { outcome: 'error', code: r.failure }
            : { outcome: 'ok', code: r.answer.outcome },
      ),
    writer: (call) =>
      step<WriterReply>(call.route, () => deps.writer(call), writerOutcome),
    renderer: {
      render: (video, pass, soundLinks) =>
        step<RenderResult>(
          'render',
          () => deps.renderer.render(video, pass, soundLinks),
          (r) => {
            if ('failure' in r) return { outcome: 'error', code: r.failure };
            if ('stopped' in r) return { outcome: 'stopped' };
            event.set({ job: { output_bytes: r.sizeBytes } });
            return { outcome: 'ok' };
          },
        ),
    },
  };

  const write = () => {
    event.set({ job: { steps } });
    const delivery = event.get('job.delivery') as Delivery | undefined;
    event.message(
      `${name} ${delivery ?? '?'} ${event.outcome ?? 'ok'} in ${event.elapsedMs()} ms`,
    );
    event.write();
  };

  return {
    deps: jobDeps,
    run: (work) => runWithEvent(event, work),
    write,
    crashed(err) {
      event.set({ job: { delivery: 'RETRY' } });
      event.fail({
        type: err instanceof Error ? err.name : 'Error',
        code: 'worker_crashed',
        retriable: true,
      });
      writeErrorLine(err, { ref: event.ref, traceId: event.traceId });
      write();
    },
  };
}
