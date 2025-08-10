// ==UserScript==
// @name         Flattrade Smart → Bills CSV (v4.3 stable, dry-run & range)
// @namespace    flattrade-smart-bills
// @version      4.3.0
// @description  Click-only scraper for Flattrade Smart bills. No top reloads. Waits for correct detail, parses trade rows, restores grid per-iteration. Has Dry Run and [start,count] range.
// @match        https://bo.ftconline.in/WebClient2425/Ledger/SmartReport.cfm*
// @match        https://bo.ftconline.in/WebClient2425/Reports/SmartReport/*
// @match        https://bo.ftconline.in/WebClient2425/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    'use strict';
    if (window.top !== window.self) return; // top-only controller

    // ---------- utils
    const log = (...a) => console.log('[smart]', ...a);
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const de = s => (s??'').replace(/\u00a0/g,' ').trim();
    const toNum = s => {
        const t = de(s).replace(/[\u2000-\u200D\u202F]/g,'').replace(/[₹,]/g,'').replace(/CR|DR/gi,'')
            .replace(/^\((.*)\)$/, '-$1').replace(/[^\d.\-]/g,'');
        const n = Number(t);
        return Number.isFinite(n) ? n : 0;
    };

    // ---------- frames
    function allFrames() {
        const out = [];
        const walk = (w, path='top') => {
            try { out.push({ win:w, doc:w.document, path, url:w.location.href }); } catch(_) {}
            const n = (w.frames && w.frames.length) || 0;
            for (let i=0;i<n;i++) try { walk(w.frames[i], `${path}>frame[${i}]`); } catch(_) {}
        };
        walk(window.top); return out;
    }
    function findGridFrame() {
        for (const f of allFrames()) {
            const rows = [...(f.doc?.querySelectorAll?.('tr')||[])];
            const bills = rows.filter(tr => /Bill/i.test(de(tr.innerText)) && tr.querySelector('td[onclick^="CallSJTransaction"]'));
            if (bills.length) return { ...f, bills };
        }
        return null;
    }
    async function waitGrid(timeout=12000) {
        const t0 = performance.now();
        while (performance.now()-t0 < timeout) {
            const g = findGridFrame();
            if (g && g.bills?.length) return g;
            await sleep(200);
        }
        throw new Error('Smart grid not found (waitGrid timeout)');
    }
    function ancestors(path) {
        const parts = (path||'').split('>');
        const out = [];
        for (let i = parts.length; i > 1; i--) out.push(parts.slice(0, i).join('>'));
        return out; // deepest-first
    }
    async function restoreGrid(detailPath) {
        const frames = allFrames();
        const origin = new URL(window.top.location.href).origin;
        const SMART  = origin + '/WebClient2425/Ledger/SmartReport.cfm';

        // 1) try detail frame itself, then its ancestors (not top)
        for (const p of ancestors(detailPath)) {
            const f = frames.find(x => x.path === p);
            if (!f || p === 'top') continue;
            console.log('[smart] restore → Smart via', p);
            try { f.win.location.replace(SMART); } catch {}
            try { const g = await waitGrid(10000); return g.doc; } catch {}
        }

        // 2) click any Smart link in any non-top frame
        for (const f of frames) {
            if (f.path === 'top') continue;
            const a = f.doc?.querySelector?.('a[href="/WebClient2425/Ledger/SmartReport.cfm"]');
            if (a) {
                console.log('[smart] restore → click Smart in', f.path);
                try { a.click(); } catch {}
                try { const g = await waitGrid(10000); return g.doc; } catch {}
            }
        }

        // 3) last resort: force top (rare)
        console.warn('[smart] restore → forcing top to Smart');
        window.top.location.replace(SMART);
        const g = await waitGrid(15000);
        return g.doc;
    }

    // ---------- grid helpers
    function buildBillIndex(doc) {
        const rows = [...doc.querySelectorAll('tr')]
            .filter(tr => /Bill/i.test((tr.innerText||'').replace(/\u00A0/g,' ').trim()) &&
                tr.querySelector('td[onclick^="CallSJTransaction"]'));
        return rows.map(tr => {
            const tds = tr.querySelectorAll('td');
            const clickCell = tr.querySelector('td[onclick^="CallSJTransaction"]');
            const onclick = clickCell?.getAttribute('onclick') || '';
            // CallSJTransaction('NSE_CASH','FT017322','M ','2024062','01/04/2024')
            const m = onclick.match(/CallSJTransaction\('([^']+)','([^']+)','([^']+)','([^']+)','([^']+)'\)/);
            const args = m ? { co: m[1], client: m[2], mktType: m[3].trim(), settle: m[4], sdate: m[5] } : null;

            return {
                tradeDate: (tds[0]?.innerText || '').replace(/\u00A0/g,' ').trim(),
                valueDate: (tds[1]?.innerText || '').replace(/\u00A0/g,' ').trim(),
                voucherNo: (clickCell?.innerText || '').replace(/\u00A0/g,' ').trim(),
                segment:   ((tds[4]||tds[5])?.innerText || '').replace(/\u00A0/g,' ').trim(),
                narration: ((tds[5]||tds[6])?.innerText || '').replace(/\u00A0/g,' ').trim(),
                debit:  toNum((tds[7]||tds[8])?.innerText),
                credit: toNum((tds[8]||tds[9])?.innerText),
                args
            };
        });
    }
    function findVoucherCell(doc, voucherNo) {
        return [...doc.querySelectorAll('td[onclick^="CallSJTransaction"]')]
            .find(td => de(td.innerText) === de(voucherNo)) || null;
    }

    // ---------- detail waiter (no URL dependence)
    async function waitVoucherView(expected, timeout=25000) {
        const t0 = performance.now();
        function headerMatches(doc) {
            const hdr = doc.querySelector('#TableHeader');
            if (!hdr) return { ok:false };
            const t = de(hdr.innerText).replace(/\s+/g, ' ');
            const mtOk = expected?.mktType ? t.includes(`Market Type : ${expected.mktType}`) : true;
            const snOk = expected?.settle  ? t.includes(`Settlement Number : ${expected.settle}`) : true;
            return { ok: mtOk && snOk, text: t };
        }
        function hasBSNHeader(doc) {
            return [...doc.querySelectorAll('tr')].some(tr => {
                const t = de(tr.innerText).replace(/\s+/g,'').toLowerCase();
                return t.includes('security') && t.includes('bought') && t.includes('sold') && t.includes('net');
            });
        }
        function screen4Rows(doc) {
            return [...doc.querySelectorAll('tr[onclick*="ShowDetails"]')]
                .filter(tr => (tr.getAttribute('onclick')||'').includes('ScreenScripSummaryForm'));
        }

        while (performance.now()-t0 < timeout) {
            for (const f of allFrames()) {
                const doc = f.doc; if (!doc) continue;
                const hm = headerMatches(doc);
                if (!hm.ok) continue;

                const rows = screen4Rows(doc);
                if (rows.length) {
                    console.log('[smart] detail view found: screen4 at', f.path, f.url);
                    return { type:'screen4', doc, path:f.path, headerText: hm.text };
                }
                if (hasBSNHeader(doc)) {
                    console.log('[smart] detail view found: summary at', f.path, f.url);
                    return { type:'summary', doc, path:f.path, headerText: hm.text };
                }
            }
            await sleep(150);
        }
        throw new Error('voucher detail not found (header/grid not detected)');
    }

    // ---------- parse detail rows (trade grid only)
    function parseItemsFromVoucher(doc, type) {
        let rows = [];
        if (type === 'screen4') {
            rows = [...doc.querySelectorAll('tr[onclick*="ShowDetails"]')]
                .filter(tr => (tr.getAttribute('onclick')||'').includes('ScreenScripSummaryForm'));
        } else {
            const headerTr = [...doc.querySelectorAll('tr')].find(tr=>{
                const t = de(tr.innerText).replace(/\s+/g,'').toLowerCase();
                return t.includes('security') && t.includes('bought') && t.includes('sold') && t.includes('net');
            });
            if (!headerTr) return [];
            const collect = (tbl) => {
                for (const tr of tbl.querySelectorAll('tr')) {
                    if (tr.querySelector('th') && /Total/i.test(tr.innerText)) return 'STOP';
                    const td = tr.querySelectorAll('td');
                    if (td.length >= 11) rows.push(tr);
                }
            };
            let t = headerTr.closest('table');
            if (t) {
                if (collect(t) !== 'STOP') {
                    let sib = t.nextElementSibling;
                    while (sib && sib.tagName === 'TABLE') {
                        if (collect(sib) === 'STOP') break;
                        sib = sib.nextElementSibling;
                    }
                }
            }
        }

        const out = [];
        for (const tr of rows) {
            const td = tr.querySelectorAll('td');
            if (td.length < 11) continue;
            out.push({
                scrip: de(td[1].textContent),
                bQty:  toNum(td[2].textContent),
                bAvg:  toNum(td[3].textContent),
                bAmt:  toNum(td[4].textContent),
                sQty:  toNum(td[5].textContent),
                sAvg:  toNum(td[6].textContent),
                sAmt:  toNum(td[7].textContent),
                nQty:  toNum(td[8].textContent),
                nAvg:  toNum(td[9].textContent),
                nAmt:  toNum(td[10].textContent),
            });
        }
        return out;
    }

    // ---------- main
    async function run({ start=0, count=Infinity, dry=false } = {}) {
        if (window.__SMART_RUNNING) { log('Already running'); return; }
        window.__SMART_RUNNING = true;
        try {
            let grid = findGridFrame();
            if (!grid) throw new Error('Smart grid not found');
            let gridDoc = grid.doc;

            const list = buildBillIndex(gridDoc);
            const end = Math.min(list.length, start + (isFinite(count) ? count : list.length));
            log(`Bills: ${list.length} | running [${start}..${end-1}] ${dry ? '(dry)' : ''}`);

            const out = [];
            for (let i = start; i < end; i++) {
                const meta = list[i];

                // Re-acquire grid if DOM got remounted (rare, before click)
                if (!document.contains(gridDoc)) {
                    const g2 = findGridFrame();
                    if (g2) gridDoc = g2.doc;
                }

                const cell = findVoucherCell(gridDoc, meta.voucherNo);
                if (!cell) { log('MISS voucher cell', meta.voucherNo, '— skipping'); continue; }

                try { cell.scrollIntoView({block:'center'}); } catch(_) {}
                cell.click();
                log(`(${i+1}/${list.length}) clicked voucher ${meta.voucherNo}`);

                // Wait for matching detail and parse it
                const expected = meta.args ? { mktType: meta.args.mktType, settle: meta.args.settle } : null;
                const ctx = await waitVoucherView(expected, 25000);
                const items = parseItemsFromVoucher(ctx.doc, ctx.type);
                console.log('[smart] view=', ctx.type, 'rows=', items.length);

                for (const it of items) {
                    out.push({
                        tradeDate: meta.tradeDate, valueDate: meta.valueDate, voucherNo: meta.voucherNo, segment: meta.segment,
                        scrip: it.scrip, bQty: it.bQty, bAvg: it.bAvg, bAmt: it.bAmt,
                        sQty: it.sQty, sAvg: it.sAvg, sAmt: it.sAmt, nQty: it.nQty, nAvg: it.nAvg, nAmt: it.nAmt,
                        debit: meta.debit, credit: meta.credit, narration: meta.narration, rowType: 'ITEM'
                    });
                }

                // If the click replaced the grid frame, bring Smart back in the same container
                let g2 = findGridFrame();
                if (!g2) {
                    gridDoc = await restoreGrid(ctx.path);
                    const g3 = findGridFrame();
                    if (g3) { log('grid path after restore:', g3.path); gridDoc = g3.doc; }
                } else {
                    gridDoc = g2.doc;
                }

                await sleep(200);
            }

            if (dry) {
                log('DRY-RUN rows=', out.length, out.slice(0, 3));
                return;
            }

            const cols = ['tradeDate','valueDate','voucherNo','segment','scrip',
                'bQty','bAvg','bAmt','sQty','sAvg','sAmt','nQty','nAvg','nAmt',
                'debit','credit','narration','rowType'];
            const csv = [cols.join(','), ...out.map(r => cols.map(k => {
                const t = String(r[k] ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g,'""')}"` : t;
            }).join(','))].join('\n');

            const a = Object.assign(document.createElement('a'), {
                href: URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'})),
                download: `flattrade-smart-bills_${start}-${end-1}.csv`
            });
            document.body.appendChild(a); a.click(); a.remove();
            log('DONE rows=', out.length);
        } catch (e) {
            console.error('[smart] FATAL', e);
        } finally {
            window.__SMART_RUNNING = false;
        }
    }

    // ---------- UI
    function ensureUI() {
        if (document.getElementById('smart-panel')) return;
        const wrap = document.createElement('div');
        wrap.id = 'smart-panel';
        Object.assign(wrap.style, {
            position:'fixed', top:'12px', right:'12px', zIndex:2147483647, display:'flex', gap:'8px',
            padding:'8px', background:'#fff', border:'1px solid #888', borderRadius:'8px', alignItems:'center'
        });

        const start = document.createElement('input');
        start.type = 'number'; start.min = '0'; start.value = '0'; start.title = 'Start index';
        Object.assign(start.style, { width:'70px', padding:'4px' });

        const count = document.createElement('input');
        count.type = 'number'; count.min = '1'; count.value = '3'; count.title = 'Count';
        Object.assign(count.style, { width:'70px', padding:'4px' });

        const dryBtn = document.createElement('button');
        dryBtn.textContent = 'Dry Run (3)';
        Object.assign(dryBtn.style, { padding:'6px 10px', border:'1px solid #888', borderRadius:'6px', background:'#eee' });
        dryBtn.onclick = () => run({ start: Number(start.value||0), count: Number(count.value||3), dry: true });

        const goBtn = document.createElement('button');
        goBtn.textContent = 'Export [Start, Count]';
        Object.assign(goBtn.style, { padding:'6px 10px', border:'1px solid #888', borderRadius:'6px', background:'#fff' });
        goBtn.onclick = () => run({ start: Number(start.value||0), count: Number(count.value||Infinity), dry: false });

        const allBtn = document.createElement('button');
        allBtn.textContent = 'Export All';
        Object.assign(allBtn.style, { padding:'6px 10px', border:'1px solid #888', borderRadius:'6px', background:'#fff' });
        allBtn.onclick = () => run({ start: 0, count: Infinity, dry: false });

        wrap.append('Start:', start, 'Count:', count, dryBtn, goBtn, allBtn);
        document.body.appendChild(wrap);
        log('UI ready (dry-run & range)');
    }
    ensureUI();
})();
