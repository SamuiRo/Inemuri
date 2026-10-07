import cron from "node-cron";
import { print, printStack } from "../../shared/utils.js";

/**
 * CronScheduler manages scheduled tasks that generate messages
 * These messages are emitted to the EventBus as message.received events
 */
export default class CronScheduler {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.jobs = new Map();
    this.isInitialized = false;
    // Ручний запуск задачі (discordapp /daily) — запитом через шину, щоб
    // discordapp не імпортував самі задачі (DISCORDAPP.md D1).
    this.eventBus.handle("cron.run", ({ id, triggeredBy = null } = {}) => this.runJob(id, { triggeredBy }));
  }

  /**
   * Initialize scheduler with job configurations
   * @param {Array} jobConfigs - Array of job configuration objects
   */
  async initialize(jobConfigs = []) {
    if (this.isInitialized) {
      print("CronScheduler already initialized", "warning");
      return;
    }

    print(`Initializing CronScheduler with ${jobConfigs.length} jobs`);

    for (const config of jobConfigs) {
      this.scheduleJob(config);
    }

    this.isInitialized = true;
    print("CronScheduler initialized successfully");
  }

  /**
   * Schedule a new cron job
   * @param {Object} config - Job configuration
   * @param {string} config.id - Unique job identifier
   * @param {string} config.schedule - Cron schedule expression
   * @param {Function} config.handler - Async function that generates message data
   * @param {string} config.description - Job description for logging
   * @param {boolean} config.enabled - Whether job is enabled
   */
  scheduleJob(config) {
    const { id, schedule, description, enabled = true } = config;

    if (!enabled) {
      print(`Skipping disabled cron job: ${id}`);
      return;
    }

    if (this.jobs.has(id)) {
      print(`Cron job ${id} already exists, skipping`, "warning");
      return;
    }

    // Validate cron expression
    if (!cron.validate(schedule)) {
      print(`Invalid cron schedule for job ${id}: ${schedule}`, "error");
      return;
    }

    const task = cron.schedule(schedule, () => this.runJob(id));

    this.jobs.set(id, {
      task,
      config,
      lastRun: null,
    });

    print(`Scheduled cron job: ${id} (${schedule}) - ${description}`);
  }

  /**
   * Виконати задачу зараз: handler → message.received, як будь-яке джерело.
   * Той самий шлях для розкладу і ручного запуску.
   *
   * @param {string} id
   * @param {{ triggeredBy?: string|null }} [opts]
   * @returns {Promise<boolean>} true — повідомлення відправлено в шину.
   */
  async runJob(id, { triggeredBy = null } = {}) {
    const job = this.jobs.get(id);
    if (!job) {
      print(`Cron job ${id} not found`, "warning");
      return false;
    }
    const { handler, description } = job.config;
    try {
      print(`Executing cron job: ${id} - ${description}`);
      const messageData = await handler();
      if (!messageData) {
        print(`Cron job ${id} returned no message data`, "warning");
        return false;
      }
      job.lastRun = new Date().toISOString();
      this.eventBus.emitMessageReceived({
        ...messageData,
        metadata: {
          ...messageData.metadata,
          source: triggeredBy ? "discord-command" : "cron",
          cronJobId: id,
          triggeredBy,
          timestamp: job.lastRun,
        },
      });
      print(`Cron job ${id} message emitted successfully`);
      return true;
    } catch (error) {
      print(`Error executing cron job ${id}: ${error.message}`, "error");
      printStack(error);
      this.eventBus.emitError({
        source: `cron:${id}`,
        error: error.message,
        stack: error.stack,
        cronJobId: id,
      });
      return false;
    }
  }

  /**
   * Stop a specific job
   */
  stopJob(id) {
    const job = this.jobs.get(id);
    if (!job) {
      print(`Cron job ${id} not found`, "warning");
      return false;
    }

    job.task.stop();
    this.jobs.delete(id);
    print(`Stopped cron job: ${id}`);
    return true;
  }

  /**
   * Stop all scheduled jobs
   */
  async stop() {
    print("Shutting down CronScheduler");

    for (const [id, job] of this.jobs.entries()) {
      job.task.stop();
      print(`Stopped cron job: ${id}`);
    }

    this.jobs.clear();
    this.isInitialized = false;
    print("CronScheduler shutdown complete");
  }

  /**
   * Get status of all jobs
   */
  getStatus() {
    const jobs = Array.from(this.jobs.entries()).map(([id, job]) => ({
      id,
      schedule: job.config.schedule,
      description: job.config.description,
      enabled: job.config.enabled,
      lastRun: job.lastRun,
    }));

    return {
      initialized: this.isInitialized,
      totalJobs: this.jobs.size,
      jobs,
    };
  }
}
