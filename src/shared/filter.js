// filter.js
// Decides whether a context object is "actionable" — i.e. worth spending a
// Claude call on — and whether we should rate-limit. Returns a decision plus
// the trigger reasons so the commentary prompt can use them.

class ActionabilityFilter {
  constructor(filterConfig) {
    this.cfg = filterConfig;
    this._zoneCooldownUntil = new Map();   // zoneId -> epochMs
    this._globalCooldownUntil = 0;
    this._lastFireTags = new Set();
    // ORB: one signal per direction per session. Cooldown lasts 8 hours from
    // the first fire — well past the 11:00 CT window. Confirmation events
    // (isConfirmation: true) are always allowed and never set the cooldown.
    this._orbLongCooldownUntil  = 0;
    this._orbShortCooldownUntil = 0;
    // Phase 4b.2: per-price cooldown for suggest_level events.
    this._suggestLevelCooldownUntil = new Map();
    // Phase 4b.3.b: per-tracked_level_id cooldown for lifecycle directives.
    this._lifecycleCooldownUntil = new Map();
  }

  evaluate(ctx, nowMs = Date.now()) {
    if (!ctx) return { fire: false, reasons: [] };

    const reasons = [];

    // Notable single/pair/triple pattern
    if (this.cfg.fireOn.notablePatterns && ctx.notable) {
      const notable = ctx.classification.tags.filter((t) => true);
      reasons.push({ kind: "pattern", tags: notable });
    }

    // Zone interactions: rejections, breakouts, breakdowns
    if (this.cfg.fireOn.zoneInteractions) {
      for (const zs of ctx.zones) {
        if (["rejected_top", "rejected_bottom", "broke_up", "broke_down"].includes(zs.interaction)) {
          // Per-zone cooldown
          const until = this._zoneCooldownUntil.get(zs.zone.id) || 0;
          if (nowMs >= until) {
            reasons.push({ kind: "zone", zoneId: zs.zone.id, label: zs.zone.label, interaction: zs.interaction });
          }
        }
      }
    }

    // Trend / MA events
    if (this.cfg.fireOn.trendOrMaEvents && ctx.maEvents && ctx.maEvents.length > 0) {
      reasons.push({ kind: "ma", events: ctx.maEvents.map((e) => e.type) });
    }

    // ORB signal path
    if (ctx.orbSignal && ctx.orbSignal.active) {
      const sig = ctx.orbSignal;
      const isConf = !!sig.isConfirmation;
      const cooldownUntil = sig.direction === 'long'
        ? this._orbLongCooldownUntil
        : this._orbShortCooldownUntil;
      // Confirmation events are exempt from cooldown; breakout events are not.
      if (isConf || nowMs >= cooldownUntil) {
        reasons.push({
          kind: isConf ? 'orb_breakout_confirmed' : 'orb_breakout',
          direction: sig.direction,
          isConfirmation: isConf,
          closePrice: sig.closePrice,
          entry: sig.entry,
          stop: sig.stop,
          target: sig.target,
          reason: sig.reason,
        });
      }
    }

    // "Every candle if actionable" — proximity to a zone counts as actionable
    if (this.cfg.fireOn.everyCandleIfActionable && reasons.length === 0) {
      const near = ctx.nearestZone;
      if (near && near.distance <= (this.cfg.zoneProximityTicks || 4) * 0.25) {
        reasons.push({ kind: "near-zone", zoneId: near.zone.id, label: near.zone.label });
      }
    }

    // ── Phase 4b.2: emerging-level suggestions ─────────────────────────────
    // Each ctx.candidateLevels entry is a swing-pivot cluster the detector
    // found. We fire a "suggest_level" reason when:
    //   (a) touchCount meets the threshold (default 3),
    //   (b) no existing zone (tvcm/orb/tracked-drawing) sits within tolerance —
    //       so we don't re-suggest something Jim already configured or drew,
    //   (c) we haven't suggested this price in the last cooldown window.
    // Suggest_level fires bypass the global cooldown (see end of method) so a
    // suggestion can't suppress a real ORB / zone interaction event.
    const suggestEnabled =
      !this.cfg.fireOn || this.cfg.fireOn.suggestedLevels !== false;
    if (suggestEnabled && Array.isArray(ctx.candidateLevels) && ctx.candidateLevels.length > 0) {
      const minTouches = this.cfg.suggestLevelMinTouches || 3;
      const tickSize   = 0.25; // MES; matches dedup elsewhere
      const dedupTol   = (this.cfg.suggestLevelDedupToleranceTicks || 4) * tickSize;
      for (const cand of ctx.candidateLevels) {
        if (!cand || cand.touchCount < minTouches) continue;
        // Skip if any pre-existing zone (configured or already drawn) sits
        // within tolerance — Jim is already aware of this price.
        const alreadyKnown = (ctx.zones || []).some((zs) => {
          const z = zs && zs.zone ? zs.zone : zs;
          if (!z || typeof z.price !== 'number') return false;
          if (!['tvcm', 'orb', 'tracked-drawing'].includes(z.source)) return false;
          return Math.abs(z.price - cand.price) <= dedupTol;
        });
        if (alreadyKnown) continue;
        // Per-price cooldown
        const key = `${ctx.symbol || '?'}|${Math.round(cand.price)}`;
        const until = this._suggestLevelCooldownUntil.get(key) || 0;
        if (nowMs < until) continue;
        reasons.push({
          kind: 'suggest_level',
          candidateLevel: {
            kind:           cand.kind,
            price:          cand.price,
            touchCount:     cand.touchCount,
            firstTouchTime: cand.firstTouchTime,
            lastTouchTime:  cand.lastTouchTime,
            strength:       cand.strength,
          },
        });
      }
    }

    if (reasons.length === 0) return { fire: false, reasons };

    // Global cooldown gates trade-like events. A reason set that is PURELY
    // suggest_level entries bypasses it — suggestions should never be silenced
    // by a recent zone-rejection cooldown.
    const allSuggestLevel = reasons.every((r) => r.kind === 'suggest_level');
    if (!allSuggestLevel && nowMs < this._globalCooldownUntil) {
      return { fire: false, reasons, suppressedBy: "global-cooldown" };
    }

    return { fire: true, reasons };
  }

  noteFired(ctx, reasons, nowMs = Date.now()) {
    // Pure suggest_level fires don't set global / per-zone cooldowns — they're
    // informational nudges, not trade events.
    const allSuggestLevel = Array.isArray(reasons) && reasons.length > 0 &&
      reasons.every((r) => r.kind === 'suggest_level');

    if (!allSuggestLevel) {
      const cd = (this.cfg.globalCooldownSec || 0) * 1000;
      this._globalCooldownUntil = nowMs + cd;
      const zoneCd = (this.cfg.perZoneCooldownSec || 0) * 1000;
      if (zoneCd > 0 && ctx.zones) {
        for (const zs of ctx.zones) {
          if (zs.interaction !== "none") {
            this._zoneCooldownUntil.set(zs.zone.id, nowMs + zoneCd);
          }
        }
      }
    }
    if (reasons) {
      // Set ORB per-direction cooldown for non-confirmation breakout fires.
      for (const r of reasons) {
        if (r.kind === 'orb_breakout' && !r.isConfirmation) {
          const orbCd = 8 * 3600 * 1000; // 8 hours — past any trading window
          if (r.direction === 'long')  this._orbLongCooldownUntil  = nowMs + orbCd;
          if (r.direction === 'short') this._orbShortCooldownUntil = nowMs + orbCd;
        }
        // Phase 4b.2: per-price cooldown on suggest_level fires.
        if (r.kind === 'suggest_level' && r.candidateLevel) {
          const cooldownSec = (this.cfg.suggestLevelCooldownSec != null)
            ? this.cfg.suggestLevelCooldownSec
            : 3600;
          const key = `${ctx.symbol || '?'}|${Math.round(r.candidateLevel.price)}`;
          this._suggestLevelCooldownUntil.set(key, nowMs + cooldownSec * 1000);
        }
        // Phase 4b.3.b: per-level lifecycle cooldown.
        if (r.kind === 'lifecycle' && r.tracked_level_id != null) {
          const cooldownSec = (this.cfg.lifecycleCooldownSec != null)
            ? this.cfg.lifecycleCooldownSec
            : 3600;
          this._lifecycleCooldownUntil.set(String(r.tracked_level_id), nowMs + cooldownSec * 1000);
        }
      }
    }
  }

  // Phase 4b.3.b: evaluate a single lifecycle directive.
  // Returns { fire, reasons, suppressedBy? }.
  // Bypasses global cooldown both ways (same policy as suggest_level).
  evaluateLifecycleDirective(symbol, directive, nowMs = Date.now()) {
    const key  = String(directive.tracked_level_id);
    const until = this._lifecycleCooldownUntil.get(key) || 0;
    if (nowMs < until) {
      return { fire: false, reasons: [], suppressedBy: 'lifecycle-cooldown' };
    }
    const reason = {
      kind:             'lifecycle',
      directive:        directive.directive,
      tracked_level_id: directive.tracked_level_id,
      price:            directive.price,
      prior_kind:       directive.prior_kind,
      new_kind:         directive.new_kind,
      zone_top:         directive.zone_top,
      zone_bottom:      directive.zone_bottom,
      rationale_short:  directive.rationale_short,
      evidence:         directive.evidence,
    };
    return { fire: true, reasons: [reason] };
  }
}

module.exports = { ActionabilityFilter };
