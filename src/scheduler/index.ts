import { Cron } from "croner";
import { logger } from "#app/logger/index";
import { waitForShutdown, validateShutdownOptions, type ShutdownOptions } from "#app/runtime/shutdown";

export interface ScheduleContext {
  signal: AbortSignal;
  scheduledAt: Date;
}
export interface Schedule {
  name: string;
  cron: string;
  overlap?: "skip" | "allow";
  job: (context: ScheduleContext) => void | Promise<void>;
}
/** Library-owned handle; no dependency-specific job objects escape the scheduler. */
export interface ScheduledJob {
  readonly name: string;
  nextInvocation(): Date | null;
  /** Cancels future invocations; active work is drained by shutdown(). */
  cancel(): void;
  /** Manual execution participates in overlap protection and shutdown tracking. */
  invoke(scheduledAt?: Date): Promise<void>;
}

export const createScheduler = (log = logger) => {
  const jobs = new Map<string, { cron: Cron; handle: ScheduledJob; active: number; disabled: boolean }>();
  const running = new Map<Promise<void>, AbortController>();
  let stopping: Promise<void> | undefined;

  const initialize = (schedules: readonly Schedule[]): ScheduledJob[] => {
    if (stopping) throw new Error("The scheduler is shutting down.");
    for (const [name, entry] of jobs) {
      if (!entry.cron.nextRun() && entry.active === 0) { entry.disabled = true; jobs.delete(name); }
    }
    const names = new Set(jobs.keys());
    for (const schedule of schedules) {
      if (!schedule.name.trim() || names.has(schedule.name)) {
        throw new Error("Schedule names must be non-empty and unique: " + schedule.name);
      }
      if (schedule.overlap !== undefined && !["skip", "allow"].includes(schedule.overlap)) {
        throw new Error("Invalid overlap policy: " + schedule.name);
      }
      names.add(schedule.name);
    }
    const created: string[] = [];
    try {
      for (const schedule of schedules) {
        let cron: Cron;
        try { cron = new Cron(schedule.cron, { paused: true }); }
        catch (cause) { throw new Error("Invalid cron expression for schedule: " + schedule.name, { cause }); }
        let expected = cron.nextRun();
        if (!expected) { cron.stop(); throw new Error("Invalid cron expression or no future execution: " + schedule.name); }
        const state = { active: 0, disabled: false };
        const invoke = async (scheduledAt = new Date()): Promise<void> => {
          if (state.disabled || (state.active > 0 && schedule.overlap !== "allow")) return;
          const fireDate = new Date(scheduledAt);
          if (!Number.isFinite(fireDate.getTime())) throw new TypeError("scheduledAt must be a valid date.");
          const now = new Date();
          if (now.getTime() - fireDate.getTime() >= 1000) {
            log.info(schedule.name + " was supposed to run at " + fireDate.toISOString()
              + ", but actually ran at " + now.toISOString());
          }
          const controller = new AbortController();
          state.active++;
          const execution = Promise.resolve().then(() => schedule.job({ signal: controller.signal, scheduledAt: fireDate }));
          running.set(execution, controller);
          try { await execution; }
          catch (error) { log.error({ job: schedule.name, error }, "Scheduled job failed"); throw error; }
          finally { running.delete(execution); state.active--; }
        };
        const handle: ScheduledJob = Object.freeze({
          name: schedule.name,
          nextInvocation: () => state.disabled ? null : cron.nextRun(),
          cancel: () => { state.disabled = true; cron.stop(); },
          invoke,
        });
        const entry = Object.assign(state, { cron, handle });
        jobs.set(schedule.name, entry);
        created.push(schedule.name);
        cron.schedule(async () => {
          const fireDate = expected ?? new Date();
          expected = cron.nextRun();
          // invoke logs failures; timer callbacks must not reject into the event loop.
          try { await invoke(fireDate); } catch { /* already reported */ }
        });
      }
      for (const name of created) jobs.get(name)!.cron.resume();
      return created.map(name => jobs.get(name)!.handle);
    } catch (error) {
      for (const name of created) { jobs.get(name)!.handle.cancel(); jobs.delete(name); }
      throw error;
    }
  };

  const shutdown = (options: ShutdownOptions = {}): Promise<void> => {
    validateShutdownOptions(options);
    if (!stopping) {
      for (const entry of jobs.values()) entry.handle.cancel();
      jobs.clear();
      for (const controller of running.values()) controller.abort(new Error("Scheduler is shutting down."));
      stopping = Promise.allSettled([...running.keys()]).then(() => {}).finally(() => { stopping = undefined; });
    }
    return waitForShutdown(stopping, options);
  };
  return { initialize, shutdown };
};

export type Scheduler = ReturnType<typeof createScheduler>;
export const defaultScheduler = createScheduler();
export const initializeScheduler = defaultScheduler.initialize;
export const shutdownScheduler = defaultScheduler.shutdown;

export type { ShutdownOptions } from "#app/runtime/shutdown";
