import { DiscoveredItem } from "../../teapot/models/index.js";
import { FLOW_TRIAGE } from "../../../config/app.config.js";
import { print } from "../../../shared/utils.js";
import { toRow } from "./candidates.js";
import { ruleVerdict } from "./rules.js";

/**
 * Вхід triage — сторона ingest (NEWS_INTAKE.md §2.2–2.3).
 *
 * Новий елемент джерела з `feed.triage: true` стає рядком discovered_items.
 * Правило (розділ зі списку deny_sections) вирішує одразу; решта чекає
 * LLM-triage у TriageStage. Без мережі — інваріант ingest
 * (docs/theflow/ARCHITECTURE.md): опитувач стрічок не має чекати на модель.
 */
export class TriageQueue {
  constructor({ profile = FLOW_TRIAGE.profile, Model = DiscoveredItem, log = print } = {}) {
    this.profile = profile;
    this.Model = Model;
    this.log = log;
  }

  /**
   * Ідемпотентно за (source_id, external_id): повтор того самого елемента
   * нічого не змінює.
   *
   * @returns {Promise<{ created: boolean, status: string }>}
   */
  async add(source, item) {
    const row = toRow(source.id, item);
    const rule = ruleVerdict(item, this.profile);
    const decision = rule
      ? { status: "rejected", decided_by: "rule", reason: rule.reason, profile_version: this.profile?.version ?? null }
      : {};
    const [record, created] = await this.Model.findOrCreate({
      where: { source_id: row.source_id, external_id: row.external_id },
      defaults: { ...row, ...decision },
    });
    if (created) {
      this.log(`[TRIAGE] ${source.channel_name} ${rule ? `rejected by rule (${rule.reason})` : "queued"}: ${row.title ?? row.url}`, "debug");
    }
    return { created, status: record.status };
  }
}

export default TriageQueue;
