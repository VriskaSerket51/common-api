import scheduler from "node-schedule";
import { randomUUID } from "node:crypto";
import { logger } from "../logger/index.js";
import { waitForShutdown, validateShutdownOptions, type ShutdownOptions } from "../shutdown.js";

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

export const createScheduler = (log = logger) => {
  const namespace = randomUUID();
  const jobs = new Map<string, { job: scheduler.Job; active: number; disabled: boolean }>();
  const running = new Map<Promise<void>, AbortController>();
  let stopping: Promise<void> | undefined;

  const initialize = (schedules: readonly Schedule[]): scheduler.Job[] => {
    if (stopping) throw new Error("The scheduler is shutting down.");
    for (const [name, entry] of jobs) {
      if (!entry.job.nextInvocation() && entry.active === 0) jobs.delete(name);
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
        const entry = { job: undefined as unknown as scheduler.Job, active: 0, disabled: false };
        const job = scheduler.scheduleJob(namespace + ":" + schedule.name, schedule.cron, async (fireDate) => {
          if (entry.disabled || (entry.active > 0 && schedule.overlap !== "allow")) return;
          const now = new Date();
          if (now.getTime() - fireDate.getTime() >= 1000) {
            log.info(schedule.name + " was supposed to run at " + fireDate.toISOString()
              + ", but actually ran at " + now.toISOString());
          }
          const controller = new AbortController();
          entry.active++;
          const execution = Promise.resolve().then(() => schedule.job({
            signal: controller.signal, scheduledAt: new Date(fireDate),
          }));
          running.set(execution, controller);
          try { await execution; } finally { running.delete(execution); entry.active--; }
        });
        if (!job) throw new Error("Invalid cron expression for schedule: " + schedule.name);
        entry.job = job;
        job.on("error", (error: unknown) => log.error({ job: schedule.name, error }, "Scheduled job failed"));
        jobs.set(schedule.name, entry);
        created.push(schedule.name);
      }
      return created.map(name => jobs.get(name)!.job);
    } catch (error) {
      for (const name of created) {
        const entry = jobs.get(name)!;
        entry.disabled = true;
        entry.job.cancel();
        jobs.delete(name);
      }
      throw error;
    }
  };

  const shutdown = (options: ShutdownOptions = {}): Promise<void> => {
    validateShutdownOptions(options);
    if (!stopping) {
      for (const entry of jobs.values()) { entry.disabled = true; entry.job.cancel(); }
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
