// CONFIGURACIÓN FIREBASE CON TUS LLAVES
const firebaseConfig = {
  apiKey: "AIzaSyARv7i6uHqYHiuRfA7jkx8MdzmVKwWqxAo",
  authDomain: "bodega-concha-toro.firebaseapp.com",
  databaseURL: "https://bodega-concha-toro-default-rtdb.firebaseio.com/", // Ajustado para Realtime Database
  projectId: "bodega-concha-toro",
  storageBucket: "bodega-concha-toro.firebasestorage.app",
  messagingSenderId: "292866536059",
  appId: "1:292866536059:web:4b69d406debf25d8d468de"
};

// Inicializar
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

let ROWS = [];
let PRODUCTS = [];
let tempImg = null;
let currentH = null;
let DB_CHANGES = {};

// ESCUCHAR CAMBIOS EN TIEMPO REAL (La Pizarra)
db.ref('bodega').on('value', (snapshot) => {
    const data = snapshot.val();
    if (data) {
        ROWS = data.rows || [{id:'R1', name:'Fila A', sizeM:15}];
        PRODUCTS = data.products || [];
    } else {
        ROWS = [{id:'R1', name:'Fila A', sizeM:15}];
        PRODUCTS = [];
    }
    render();
});

// GUARDAR EN LA NUBE
function sync() {
    db.ref('bodega').set({
        rows: ROWS,
        products: PRODUCTS
    });
}

function render() {
    const wrap = document.getElementById('whWrap');
    if(!wrap) return;
    wrap.innerHTML = '';
    let alerts = [];

    ROWS.forEach(row => {
        const rowProds = PRODUCTS.filter(p => p.rowId === row.id);
        const used = rowProds.reduce((s, p) => s + p.widthM, 0);
        const perc = ((used / row.sizeM) * 100).toFixed(1);

        const container = document.createElement('div');
        container.className = 'row-container';
        container.innerHTML = `
            <div class="row-header">
                <div class="row-info"><b>${row.name}</b> <span>${used.toFixed(2)}m / ${row.sizeM}m (${perc}%)</span></div>
                <button class="btn btn-secondary" style="padding:4px 8px; font-size:0.6rem" onclick="openRowModal('${row.id}')">⚙️ Editar</button>
            </div>
            <div class="wh-row" id="${row.id}" ondragover="event.preventDefault()" ondrop="drop(event)"></div>
        `;
        const rowEl = container.querySelector('.wh-row');
        
        rowProds.forEach((p, index) => {
            if(p.current < p.min) alerts.push(p.name);
            const posLabel = `${row.name.split(' ').pop()}${index + 1}`;
            const pEl = document.createElement('div');
            pEl.className = `product ${currentH === p.sku ? 'is-highlighted' : ''}`;
            pEl.id = `p-${p.sku}`;
            pEl.draggable = true;
            pEl.style.width = (p.widthM / row.sizeM * 100) + '%';
            pEl.style.background = p.color + '22';
            pEl.style.borderTop = `4px solid ${p.color}`;
            pEl.ondragstart = (e) => e.dataTransfer.setData("sku", p.sku);
            pEl.onclick = () => openProductModal(p.sku);
            pEl.innerHTML = `<div class="product-pos">${posLabel}</div><div class="product-name"><span class="stock-dot" style="background:${p.current < p.min ? 'var(--danger)' : 'var(--ok)'}"></span>${p.name}</div><div class="product-sku">${p.sku}</div>`;
            rowEl.appendChild(pEl);
        });
        wrap.appendChild(container);
    });

    const ab = document.getElementById('alertBar');
    if(alerts.length) { ab.style.display='flex'; document.getElementById('alertText').innerText = alerts.join(', '); }
    else ab.style.display='none';
}

function drop(e) {
    e.preventDefault();
    const sku = e.dataTransfer.getData("sku");
    const targetRowId = e.currentTarget.id;
    const p = PRODUCTS.find(x => x.sku === sku);
    const rowProds = PRODUCTS.filter(x => x.rowId === targetRowId && x.sku !== sku);
    const used = rowProds.reduce((s, x) => s + x.widthM, 0);
    const targetRow = ROWS.find(r => r.id === targetRowId);

    if (used + p.widthM > targetRow.sizeM) return alert("Sin espacio.");
    const rowEl = document.getElementById(targetRowId);
    const children = Array.from(rowEl.children);
    let insertIdx = children.length;
    children.forEach((child, idx) => {
        const rect = child.getBoundingClientRect();
        if (e.clientX < (rect.left + rect.width / 2) && insertIdx === children.length) insertIdx = idx;
    });
    rowProds.splice(insertIdx, 0, p);
    p.rowId = targetRowId;
    PRODUCTS = [...PRODUCTS.filter(x => x.rowId !== targetRowId), ...rowProds];
    sync();
}

function handleSearch(v, boxId, isDB) {
    const s = document.getElementById(boxId);
    if(!v) { s.style.display='none'; if(isDB) filterDB(''); return; }
    const m = PRODUCTS.filter(p => p.sku.toLowerCase().includes(v.toLowerCase()) || p.name.toLowerCase().includes(v.toLowerCase()));
    s.style.display = m.length ? 'block' : 'none';
    s.innerHTML = m.map(p => `<div class="suggestion-item" onclick="selectSuggestion('${p.sku}', '${boxId}', ${isDB})"><b>${p.sku}</b> - ${p.name}</div>`).join('');
    if(isDB) filterDB(v);
}

function selectSuggestion(sku, boxId, isDB) {
    document.getElementById(boxId).style.display = 'none';
    if(isDB) filterDB(sku);
    else { currentH = sku; render(); document.getElementById(`p-${sku}`)?.scrollIntoView({behavior:'smooth', block:'center'}); }
}

function openProductModal(sku = null) {
    const sel = document.getElementById('pRowSelect');
    sel.innerHTML = ROWS.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
    tempImg = null;
    if(sku) {
        const p = PRODUCTS.find(x => x.sku === sku);
        if(!p) return;
        document.getElementById('pSku').value = p.sku; document.getElementById('pSku').disabled = true;
        document.getElementById('pName').value = p.name; document.getElementById('pWidth').value = p.widthM;
        document.getElementById('pColor').value = p.color; document.getElementById('pRowSelect').value = p.rowId;
        document.getElementById('pCurrent').value = p.current; document.getElementById('pMin').value = p.min;
        document.getElementById('pMax').value = p.max; tempImg = p.photo;
        document.getElementById('pImgPreview').innerHTML = p.photo ? `<img src="${p.photo}">` : '<span>Sin Imagen</span>';
        document.getElementById('btnDelProd').style.display = 'block';
    } else {
        document.getElementById('pSku').value = ''; document.getElementById('pSku').disabled = false;
        document.getElementById('pName').value = ''; document.getElementById('pImgPreview').innerHTML = '<span>Sin Imagen</span>';
        document.getElementById('btnDelProd').style.display = 'none';
    }
    document.getElementById('productModal').classList.add('open');
}

function saveProduct() {
    const sku = document.getElementById('pSku').value;
    if(!sku) return;
    const data = {
        sku, name: document.getElementById('pName').value, widthM: parseFloat(document.getElementById('pWidth').value) || 0.8,
        color: document.getElementById('pColor').value, rowId: document.getElementById('pRowSelect').value,
        current: parseInt(document.getElementById('pCurrent').value) || 0, min: parseInt(document.getElementById('pMin').value) || 0,
        max: parseInt(document.getElementById('pMax').value) || 0, photo: tempImg
    };
    const idx = PRODUCTS.findIndex(p => p.sku === sku);
    if(idx >= 0) PRODUCTS[idx] = data; else PRODUCTS.push(data);
    sync(); closeProductModalOnly();
}

function openInventoryDB() { DB_CHANGES = {}; document.getElementById('dbModal').classList.add('open'); filterDB(''); }

function filterDB(q) {
    const b = document.getElementById('dbTableBody');
    b.innerHTML = '';
    PRODUCTS.filter(p => p.sku.toLowerCase().includes(q.toLowerCase()) || p.name.toLowerCase().includes(q.toLowerCase())).forEach((p) => {
        const row = ROWS.find(r => r.id === p.rowId);
        const pIdx = PRODUCTS.filter(x => x.rowId === p.rowId).findIndex(x => x.sku === p.sku) + 1;
        const pos = `${row.name.split(' ').pop()}${pIdx}`;
        const displayStock = DB_CHANGES[p.sku] !== undefined ? DB_CHANGES[p.sku] : p.current;
        b.innerHTML += `<tr>
            <td><b style="color:var(--accent)">${pos}</b></td>
            <td>${p.sku}</td><td>${p.name}</td>
            <td><input type="number" value="${displayStock}" oninput="DB_CHANGES['${p.sku}'] = parseInt(this.value)"></td>
            <td>${p.min}</td>
            <td><button class="btn btn-secondary" style="padding:4px 8px" onclick="openProductModal('${p.sku}')">Ver</button></td>
        </tr>`;
    });
}

function applyDBChanges() {
    Object.keys(DB_CHANGES).forEach(sku => { const p = PRODUCTS.find(x => x.sku === sku); if(p) p.current = DB_CHANGES[sku]; });
    sync(); closeModals();
}

function openRowModal(id = null) {
    const r = id ? ROWS.find(x => x.id === id) : {id:'', name:'', sizeM:15};
    document.getElementById('rId').value = r.id; document.getElementById('rName').value = r.name; document.getElementById('rSize').value = r.sizeM;
    document.getElementById('btnDelRow').style.display = id ? 'block' : 'none';
    document.getElementById('rowModal').classList.add('open');
}

function saveRow() {
    const id = document.getElementById('rId').value;
    const data = { id: id || 'R'+Date.now(), name: document.getElementById('rName').value, sizeM: parseFloat(document.getElementById('rSize').value) };
    if(id) ROWS[ROWS.findIndex(x=>x.id===id)] = data; else ROWS.push(data);
    sync(); closeModals();
}

function deleteRow() {
    const id = document.getElementById('rId').value;
    if(PRODUCTS.some(p => p.rowId === id)) return alert("Fila con productos.");
    if(confirm("¿Eliminar?")) { ROWS = ROWS.filter(r => r.id !== id); sync(); closeModals(); }
}

function deleteProduct() { if(confirm("¿Eliminar?")) { PRODUCTS = PRODUCTS.filter(p => p.sku !== document.getElementById('pSku').value); sync(); closeProductModalOnly(); } }

function processImage(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const scale = 300 / img.width; canvas.width = 300; canvas.height = img.height * scale;
                canvas.getContext('2d').drawImage(img, 0,0,300, canvas.height);
                tempImg = canvas.toDataURL('image/jpeg', 0.6);
                document.getElementById('pImgPreview').innerHTML = `<img src="${tempImg}">`;
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function closeModals() { document.querySelectorAll('.modal').forEach(m => m.classList.remove('open')); }
function closeProductModalOnly() { document.getElementById('productModal').classList.remove('open'); }
