// 1. CONFIGURACIÓN FIREBASE
const firebaseConfig = {
  apiKey: "AIzaSyARv7i6uHqYHiuRfA7jkx8MdzmVKwWqxAo",
  authDomain: "bodega-concha-toro.firebaseapp.com",
  databaseURL: "https://bodega-concha-toro-default-rtdb.firebaseio.com/",
  projectId: "bodega-concha-toro",
  storageBucket: "bodega-concha-toro.firebasestorage.app",
  messagingSenderId: "292866536059",
  appId: "1:292866536059:web:4b69d406debf25d8d468de"
};

// 2. INICIALIZACIÓN
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

let ROWS = [];
let PRODUCTS = [];
let tempImg = null;
let currentH = null;
let DB_CHANGES = {};

// 3. SISTEMA DE LOGIN Y CARGA DE DATOS
auth.onAuthStateChanged((user) => {
    const screen = document.getElementById('loginScreen');
    if (user) {
        screen.style.display = 'none'; // Usuario entró
        
        // Escuchar cambios en la nube solo si hay usuario logueado
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
    } else {
        screen.style.display = 'flex'; // No hay usuario
    }
});

function handleLogin() {
    const email = document.getElementById('loginEmail').value;
    const pass = document.getElementById('loginPass').value;
    const errorMsg = document.getElementById('loginError');

    auth.signInWithEmailAndPassword(email, pass)
        .catch((error) => {
            errorMsg.style.display = 'block';
            console.error("Error:", error.message);
        });
}

function logout() {
    auth.signOut();
}

// 4. FUNCIONES DE LA BODEGA
function sync() {
    if (auth.currentUser) {
        db.ref('bodega').set({
            rows: ROWS,
            products: PRODUCTS
        });
    }
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
            </div>
            <div class="wh-row" id="${row.id}"></div>
        `;
        const rowEl = container.querySelector('.wh-row');
        
        rowProds.forEach((p, index) => {
            if(p.current < p.min) alerts.push(p.name);
            const posLabel = `${row.name.split(' ').pop()}${index + 1}`;
            const pEl = document.createElement('div');
            pEl.className = `product ${currentH === p.sku ? 'is-highlighted' : ''}`;
            pEl.style.width = (p.widthM / row.sizeM * 100) + '%';
            pEl.style.borderTop = `4px solid ${p.color}`;
            pEl.onclick = () => openProductModal(p.sku);
            pEl.innerHTML = `<div class="product-pos">${posLabel}</div><div class="product-name">${p.name}</div>`;
            rowEl.appendChild(pEl);
        });
        wrap.appendChild(container);
    });

    const ab = document.getElementById('alertBar');
    if(alerts.length) { 
        ab.style.display='flex'; 
        document.getElementById('alertText').innerText = alerts.join(', '); 
    } else {
        ab.style.display='none';
    }
}

function openProductModal(sku = null) {
    const sel = document.getElementById('pRowSelect');
    sel.innerHTML = ROWS.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
    tempImg = null;
    if(sku) {
        const p = PRODUCTS.find(x => x.sku === sku);
        document.getElementById('pSku').value = p.sku; document.getElementById('pSku').disabled = true;
        document.getElementById('pName').value = p.name; document.getElementById('pWidth').value = p.widthM;
        document.getElementById('pColor').value = p.color; document.getElementById('pRowSelect').value = p.rowId;
        document.getElementById('pCurrent').value = p.current; document.getElementById('pMin').value = p.min;
        document.getElementById('pMax').value = p.max; tempImg = p.photo;
        document.getElementById('pImgPreview').innerHTML = p.photo ? `<img src="${p.photo}">` : '<span>Sin Imagen</span>';
        document.getElementById('btnDelProd').style.display = 'block';
    } else {
        document.getElementById('pSku').value = ''; document.getElementById('pSku').disabled = false;
        document.getElementById('pName').value = ''; document.getElementById('btnDelProd').style.display = 'none';
        document.getElementById('pImgPreview').innerHTML = '<span>Sin Imagen</span>';
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
    PRODUCTS.forEach((p) => {
        b.innerHTML += `<tr>
            <td>${p.sku}</td><td>${p.name}</td>
            <td><input type="number" value="${p.current}" oninput="DB_CHANGES['${p.sku}'] = parseInt(this.value)"></td>
            <td>${p.min}</td>
            <td><button class="btn btn-secondary" onclick="openProductModal('${p.sku}')">Ver</button></td>
        </tr>`;
    });
}

function applyDBChanges() {
    Object.keys(DB_CHANGES).forEach(sku => { const p = PRODUCTS.find(x => x.sku === sku); if(p) p.current = DB_CHANGES[sku]; });
    sync(); closeModals();
}

function closeModals() { document.querySelectorAll('.modal').forEach(m => m.classList.remove('open')); }
function closeProductModalOnly() { document.getElementById('productModal').classList.remove('open'); }

function processImage(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = (e) => {
            tempImg = e.target.result;
            document.getElementById('pImgPreview').innerHTML = `<img src="${tempImg}">`;
        };
        reader.readAsDataURL(input.files[0]);
    }
}
