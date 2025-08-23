(() => {
    const pick = (el) => (el?.innerText || "").replace(/\u00a0/g, " ").trim();
    const toNum = (s) => {
        if (!s) return 0;
        const m = String(s).match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/);
        return m ? parseFloat(m[0].replace(/,/g, "")) : 0;
    };
    const dl = (name, text) => {
        const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name; document.body.appendChild(a); a.click();
        URL.revokeObjectURL(url); a.remove();
    };

    // Grab data rows (skip header rows that use <th>)
    const rows = Array.from(document.querySelectorAll("tr"))
        .filter(tr => tr.querySelectorAll("td").length >= 10);

    const parsed = rows.map(tr => {
        const tds = tr.querySelectorAll("td");
        // Column map from your HTML:
        // 0 Trd Date | 1 V.Date | 2 Voucher | 3 No | 4 Code | 5 Narration | 6 ChqNo | 7 Debit | 8 Credit | 9 Balance (+ DR/CR)
        const trdDate   = pick(tds[0]);
        const vDate     = pick(tds[1]);
        const voucher   = pick(tds[2]).toUpperCase();      // "BILL", "SJ", "JV", "BR", "BP" etc
        const vNo       = pick(tds[3]);
        const code      = pick(tds[4]).toUpperCase();      // "NSE_CASH", "BSE_CASH", etc
        const narration = pick(tds[5]);
        const chqNo     = pick(tds[6]);
        const debitTxt  = pick(tds[7]);
        const creditTxt = pick(tds[8]);
        const balTxt    = pick(tds[9]);

        const debit  = toNum(debitTxt);
        const credit = toNum(creditTxt);
        const balNum = toNum(balTxt);
        const balCR  = /\bCR\b/i.test(balTxt);
        const balDR  = /\bDR\b/i.test(balTxt);

        // Classify row (so we can ignore noise like DP transfers in totals)
        const text = `${voucher} ${code} ${narration}`.toUpperCase();
        const isCashSeg = /(NSE_CASH|BSE_CASH)/.test(text);
        const isBill = /BILL\s*ENTRY/i.test(narration);
        const isDP   = /DP\s+BALANCE\s+TRANSFER/i.test(narration);
        const isBankReceipt = /(RECEIVED AMOUNT THROUGH PAYMENT GATEWAY|BANK RECEIPT|RECEIPT|NEFT|RTGS)/i.test(narration);
        const isPayout = /PAYOUT REQUEST|AUTO SETTLEMENT/i.test(narration);
        const isShuffle = /INTER EXCHANGE SETL|SHUFFLING ALLOCATION BETWEEN SEGMENTS|FUND TRANSFER FROM/i.test(narration);
        const isCharges = /STT|GST|BROKERAGE|STAMP/i.test(narration);

        let category = "OTHER";
        if (isBill && isCashSeg) category = "BILL_ENTRY_CASH";
        else if (isDP) category = "DP_TRANSFER";
        else if (isPayout) category = "BANK_PAYOUT";
        else if (isBankReceipt) category = "BANK_RECEIPT";
        else if (isShuffle) category = "SEGMENT_SHUFFLE";
        else if (isCharges) category = "CHARGES";

        return { trdDate, vDate, voucher, vNo, code, narration, chqNo, debit, credit, balNum, balSign: balCR ? "CR" : (balDR ? "DR" : ""), category };
    });

    // Core totals: ONLY Bill Entry + Cash segments
    const billRows = parsed.filter(r => r.category === "BILL_ENTRY_CASH");
    const totalBuy  = billRows.reduce((s, r) => s + r.debit,  0);   // Debit ⇒ buy
    const totalSell = billRows.reduce((s, r) => s + r.credit, 0);   // Credit ⇒ sell

    console.table([
        { metric: "Rows parsed (all)", value: parsed.length },
        { metric: "Rows kept (BILL_ENTRY_CASH)", value: billRows.length },
        { metric: "Total BUY (₹, sum of Debit)", value: totalBuy.toFixed(2) },
        { metric: "Total SELL (₹, sum of Credit)", value: totalSell.toFixed(2) },
    ]);

    // === CSV 1: bill entries only (for reconciliation) ===
    const billHeader = ["trd_date","v_date","voucher","voucher_no","code","narration","debit","credit","balance","balance_sign"];
    const billLines = [billHeader.join(",")].concat(
        billRows.map(r => [
            r.trdDate, r.vDate, r.voucher, r.vNo, r.code,
            r.narration.replace(/,/g, " "),
            r.debit.toFixed(2), r.credit.toFixed(2),
            r.balNum.toFixed(2), r.balSign
        ].join(","))
    );
    billLines.push([",,,,,TOTALS", totalBuy.toFixed(2), totalSell.toFixed(2), ""].join(","));
    dl("ledger_bill_entry_cash.csv", billLines.join("\n"));

    // === CSV 2: full dump with categories (for audit) ===
    const fullHeader = ["trd_date","v_date","voucher","voucher_no","code","category","narration","debit","credit","balance","balance_sign"];
    const fullLines = [fullHeader.join(",")].concat(
        parsed.map(r => [
            r.trdDate, r.vDate, r.voucher, r.vNo, r.code, r.category,
            r.narration.replace(/,/g, " "),
            r.debit.toFixed(2), r.credit.toFixed(2),
            r.balNum.toFixed(2), r.balSign
        ].join(","))
    );
    dl("ledger_full_dump.csv", fullLines.join("\n"));

    return { totalBuy, totalSell, rowsKept: billRows.length };
})();
