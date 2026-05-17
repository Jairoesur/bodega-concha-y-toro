const isCompact = (p.widthM / row.sizeM * rowEl.offsetWidth) < 70;

if(isCompact) pEl.classList.add('compact');

pEl.innerHTML = `
    <div class="product-pos">${posLabel}</div>

    <div class="product-name">
        <span class="stock-dot" style="background:${p.current < p.min ? 'var(--danger)' : 'var(--ok)'}"></span>
        ${p.name}
    </div>

    <div class="product-sku">${p.sku}</div>

    <div class="product-tooltip">
        <div class="tt-title">${p.name}</div>
        <div class="tt-sku">${p.sku}</div>
        <div style="margin-top:6px; font-size:0.7rem;">
            Stock: ${p.current}
        </div>
    </div>
`;
