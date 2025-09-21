(() => {
    const DEBUG = true;
    const log = (...a) => DEBUG && console.log('[CSV-SCRAPER]', ...a);
    const warn = (...a) => console.warn('[CSV-SCRAPER]', ...a);
    const err  = (...a) => console.error('[CSV-SCRAPER]', ...a);
    const must = (c, m) => { if (!c) throw new Error(m); };

    try {
        log('Start');

        // --- helpers
        const clean = v => String(v ?? '').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim();
        const csvEscape = s => /[",\n]/.test(s = String(s ?? '')) ? `"${s.replace(/"/g,'""')}"` : s;
        const parseTitle = (title) => {
            const out = { Name:'', NSE:'', BSE:'', ISIN:'' };
            if (!title) return out;
            title.split(/\r?\n/).forEach(line => {
                const m = line.match(/^\s*([^:]+)\s*:\s*(.+)\s*$/);
                if (!m) return;
                const key = m[1].toLowerCase(), val = clean(m[2]);
                if (key.includes('name')) out.Name = val;
                else if (key.includes('nse')) out.NSE = val;
                else if (key.includes('bse')) out.BSE = val;
                else if (key.includes('isin')) out.ISIN = val;
            });
            return out;
        };

        // --- 1) find header row anywhere
        const allTr = [...document.querySelectorAll('tr')];
        const headerRow = allTr.find(tr => {
            const cells = [...tr.children].map(td => clean(td.textContent || '').toLowerCase());
            return cells.includes('code') && cells.includes('scrip');
        });
        must(headerRow, 'Header row not found (needs "Code" and "Scrip").');
        const headerCells = [...headerRow.children].map(td => clean(td.textContent || '').toLowerCase());
        log('Header cells:', headerCells);

        // --- 2) build column index map (punctuation/space tolerant)
        const need = ['code','scrip','col. qty','ben.qty','inshort','outshort','poa','non poa','net','cl.price','amount'];
        const colIndex = {};
        need.forEach(k => {
            const idx = headerCells.findIndex(h => h.replace(/\s+|\./g,'') === k.replace(/\s+|\./g,''));
            if (idx === -1) warn('Missing column in header:', k);
            colIndex[k] = idx;
        });
        must(colIndex['code'] !== -1 && colIndex['scrip'] !== -1, 'Critical columns missing (Code/Scrip).');
        log('Column indices:', colIndex);

        // --- 3) collect data rows
        let dataRows = [];

        // 3a) try inside the same table first
        const table = headerRow.closest('table');
        if (table) {
            const inTable = [...table.querySelectorAll('tr')].filter(tr => tr !== headerRow && tr.querySelectorAll('td').length >= 11);
            log('In-table data rows:', inTable.length);
            dataRows = inTable;
        }

        // 3b) fallback: rows outside table (broken markup)
        if (dataRows.length === 0) {
            // heuristic 1: rows with onmouseover/onmouseout (your sample)
            const hoverRows = [...document.querySelectorAll('tr[onmouseover], tr[onmouseout]')].filter(tr => tr.querySelectorAll('td').length >= 11);
            log('Hover-rows heuristic found:', hoverRows.length);
            dataRows = hoverRows;
        }
        if (dataRows.length === 0) {
            // heuristic 2: any TR with ≥11 TDs that isn’t the header row and has non-empty first two cells
            const fatRows = allTr.filter(tr => {
                if (tr === headerRow) return false;
                const tds = tr.querySelectorAll('td');
                if (tds.length < 11) return false;
                const first = clean(tds[0].innerText), second = clean(tds[1].innerText);
                return !!(first || second);
            });
            log('Wide-rows heuristic found:', fatRows.length);
            dataRows = fatRows;
        }

        must(dataRows.length > 0, 'No data rows found. Try scrolling (lazy render) or run inside the correct iframe.');

        // --- 4) build CSV rows
        const outHeader = ['Code','Scrip','ColQty','BenQty','InShort','OutShort','POA','NonPOA','Net','ClPrice','Amount','Name','NSE','BSE','ISIN'];
        const rows = [];

        dataRows.forEach((tr, i) => {
            const tds = [...tr.querySelectorAll('td')];
            const get = (key) => {
                const idx = colIndex[key];
                return (idx >= 0 && idx < tds.length) ? clean(tds[idx].innerText || '') : '';
            };
            const scripCell = (() => {
                const idx = colIndex['scrip'];
                return (idx >= 0 && idx < tds.length) ? tds[idx] : null;
            })();
            const meta = parseTitle(scripCell?.getAttribute('title') || '');

            const row = [
                get('code'),
                clean(scripCell?.innerText || ''),
                get('col. qty'),
                get('ben.qty'),
                get('inshort'),
                get('outshort'),
                get('poa'),
                get('non poa'),
                get('net'),
                get('cl.price'),
                get('amount'),
                meta.Name, meta.NSE, meta.BSE, meta.ISIN
            ];

            // sanity
            if (!row[0] && !row[1]) {
                if (i < 5) warn(`Skipping empty-looking row ${i}`);
                return;
            }
            rows.push(row);
        });

        log('Parsed data rows:', rows.length);
        must(rows.length > 0, 'Parsed zero usable rows after filtering.');

        // --- 5) download CSV
        const csv = [outHeader, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'holdings.csv';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);

        log('Done. Download triggered. CSV bytes:', csv.length);
    } catch (e) {
        err('FAILED ->', e.message);
        try { navigator.clipboard?.writeText?.(String(e.stack || e.message || e)); } catch {}
    }
})();
