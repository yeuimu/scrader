// hands/act/rehearse.js — 演练：新逻辑先过静态快照（快介质、机器速度、零输入事件），全绿才上真实慢介质
// checkPlan 是纯函数：只依赖快照 + 计划 + 缓存，可离线单测
'use strict';

// 返回 { pass, steps: [{verb, ok, note}], lazy: [...] }
// lazy = 当前快照无法静态裁决、执行时需现场探测的步骤（如懒加载区块）
function checkPlan(snap, plan, cache) {
  const steps = [], lazy = [];
  let nth = 0; // open_item 游标（演练按顺序数卡片）
  for (const st of plan.steps || []) {
    const v = st.verb, a = st.args || {};
    if (v === 'open_item') {
      const idx = a.nth != null ? a.nth : nth;
      nth = idx + 1;
      const ok = idx < snap.nCards;
      steps.push({ verb: v, ok, note: ok ? `卡片#${idx} (${snap.cards[idx] && snap.cards[idx].id}) 在快照视口` : `索引 ${idx} 超出快照卡片数 ${snap.nCards}` });
    } else if (v === 'goto_section') {
      const known = cache.sections && cache.sections[a.section];
      const seen = snap.sections && snap.sections[a.section];
      if (!known) steps.push({ verb: v, ok: false, note: `缓存无区块 "${a.section}" 的标记模式——先探察后入库` });
      else if (seen) steps.push({ verb: v, ok: true, note: `标记已见 "${seen.text}" @docY ${seen.docY}` });
      else { steps.push({ verb: v, ok: true, note: '快照未见标记（懒加载深处），执行时分段深滚+停滞熔断' }); lazy.push(v + ':' + a.section); }
    } else if (v === 'click_verified') {
      if (a.kind === 'section_image') {
        const known = cache.sections && cache.sections[a.section];
        steps.push({ verb: v, ok: !!known, note: known ? '区块图走垂直带扫法（执行时现测坐标）' : `缓存无区块 "${a.section}"` });
        if (known) lazy.push(v + ':' + a.section);
      } else steps.push({ verb: v, ok: false, note: `未知目标 kind "${a.kind}"` });
    } else if (v === 'read_scroll' || v === 'press_key' || v === 'close_tab' || v === 'wait') {
      steps.push({ verb: v, ok: true, note: '' });
    } else {
      steps.push({ verb: v, ok: false, note: '未知动词' });
    }
  }
  return { pass: steps.every((s) => s.ok), steps, lazy };
}

module.exports = { checkPlan };
