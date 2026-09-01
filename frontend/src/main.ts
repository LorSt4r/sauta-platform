import './style.css';

// Stato globale minimale
interface State {
  cart: Record<string, number>;
  total: number;
}

interface WalletCredential {
  sessionId: string;
  token: string;
}

interface WalletResponseEntry {
  session: {
    id: string;
    totalAmount: number;
    createdAt: string;
  };
  venue: {
    name: string;
  };
  tickets: Array<{
    id: string;
    productName: string;
    status: string;
  }>;
}

function readWalletCredentials(): WalletCredential[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('sauta_wallet') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is WalletCredential =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as WalletCredential).sessionId === 'string' &&
        typeof (item as WalletCredential).token === 'string'
      );
  } catch {
    return [];
  }
}

const state: State = {
  cart: {},
  total: 0
};

// Nomi e prezzi dei drink caricati dinamicamente dal server
let DRINK_NAMES: Record<string, string> = {};
let PRICES: Record<string, number> = {};

let isTenantLoaded = false;

function showTenantError(message: string) {
  isTenantLoaded = false;
  console.error('Tenant Error:', message);
  const titleEl = document.querySelector('.header-content h1') || document.querySelector('h1');
  if (titleEl) {
    titleEl.textContent = 'Servizio non disponibile';
  }
  const subtitleEl = document.querySelector('.header-content p') || document.querySelector('p');
  if (subtitleEl) {
    subtitleEl.textContent = message;
  }
  const menuSection = document.querySelector('.menu-section');
  if (menuSection) {
    menuSection.querySelectorAll('button').forEach((btn) => {
      (btn as HTMLButtonElement).disabled = true;
    });
  }
}

async function fetchVenueAndMenu(): Promise<boolean> {
  try {
    const venueRes = await fetch('/api/venue/current');
    if (!venueRes.ok) {
      showTenantError('Locale non disponibile o indirizzo non valido.');
      return false;
    }
    const venueData = await venueRes.json();
    if (!venueData || !venueData.venue || !venueData.venue.name) {
      showTenantError('Locale non attivo o non disponibile.');
      return false;
    }

    const titleEl = document.querySelector('.header-content h1') || document.querySelector('h1');
    if (titleEl) {
      titleEl.textContent = venueData.venue.name;
    }

    const menuRes = await fetch('/api/venue/current/menu');
    if (!menuRes.ok) {
      showTenantError('Impossibile caricare il menu per questo locale.');
      return false;
    }
    const { products } = await menuRes.json();
    if (!products || !Array.isArray(products) || products.length === 0) {
      showTenantError('Nessun prodotto disponibile.');
      return false;
    }

    DRINK_NAMES = {};
    PRICES = {};

    const container = document.getElementById('menu-drinks-grid');
    if (container) {
      container.replaceChildren();
      for (const p of products) {
        PRICES[p.slug] = p.price / 100;
        DRINK_NAMES[p.slug] = p.name;

        const card = document.createElement('div');
        card.className = 'product-card featured-card gradient-gin';

        const info = document.createElement('div');
        info.className = 'product-info';
        const h3 = document.createElement('h3');
        h3.textContent = p.name;
        info.appendChild(h3);

        const action = document.createElement('div');
        action.className = 'product-action';
        const priceSpan = document.createElement('span');
        priceSpan.className = 'price';
        priceSpan.textContent = `€${(p.price / 100).toFixed(2)}`;

        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.dataset.addProduct = p.slug;
        btn.textContent = 'Ordina 🎟️';
        btn.addEventListener('click', () => (window as any).addToCart(p.slug));

        action.append(priceSpan, btn);
        card.append(info, action);
        container.appendChild(card);
      }
    }

    isTenantLoaded = true;
    return true;
  } catch (err) {
    showTenantError('Errore di connessione al servizio.');
    return false;
  }
}

// Rende la funzione addToCart disponibile globalmente per i pulsanti inline nell'HTML
(window as any).addToCart = (productId: string) => {
  if (!isTenantLoaded) return;
  if (!state.cart[productId]) {
    state.cart[productId] = 0;
  }
  state.cart[productId] += 1;
  state.total += PRICES[productId];

  updateCartUI();
};

(window as any).removeFromCart = (productId: string) => {
  if (state.cart[productId] && state.cart[productId] > 0) {
    state.cart[productId] -= 1;
    state.total -= PRICES[productId];
    if (state.cart[productId] === 0) {
      delete state.cart[productId];
    }
    updateCartUI();
  }
};

function updateCartUI() {
  const drawer = document.getElementById('checkout-drawer');
  const totalEl = document.getElementById('cart-total');

  if (drawer && totalEl) {
    if (state.total > 0) {
      drawer.classList.add('visible');
      totalEl.textContent = `€${state.total.toFixed(2)}`;

      // Rendering lista items carrello
      const itemsContainer = document.getElementById('cart-items');
      if (itemsContainer) {
        itemsContainer.replaceChildren();
        for (const [id, qty] of Object.entries(state.cart)) {
          const name = DRINK_NAMES[id] || id;
          const item = document.createElement('div');
          item.className = 'cart-item';

          const info = document.createElement('div');
          info.className = 'cart-item-info';
          const nameEl = document.createElement('span');
          nameEl.className = 'cart-item-name';
          nameEl.textContent = name;
          const priceEl = document.createElement('span');
          priceEl.className = 'cart-item-price';
          priceEl.textContent = `€${(PRICES[id] * qty).toFixed(2)}`;
          info.append(nameEl, priceEl);

          const actions = document.createElement('div');
          actions.className = 'cart-item-actions';
          const removeButton = document.createElement('button');
          removeButton.className = 'btn-icon';
          removeButton.type = 'button';
          removeButton.textContent = '-';
          removeButton.addEventListener('click', () => (window as any).removeFromCart(id));
          const quantityEl = document.createElement('span');
          quantityEl.textContent = String(qty);
          const addButton = document.createElement('button');
          addButton.className = 'btn-icon';
          addButton.type = 'button';
          addButton.textContent = '+';
          addButton.addEventListener('click', () => (window as any).addToCart(id));
          actions.append(removeButton, quantityEl, addButton);

          item.append(info, actions);
          itemsContainer.appendChild(item);
        }
      }

      // Aggiorna l'importo nel foglio nativo Apple/Google Pay
      if (paymentRequest) {
        try {
          paymentRequest.update({
            total: {
              label: 'Sauta Order',
              amount: Math.round(state.total * 100),
            }
          });
        } catch (e) {
          console.warn('Errore Stripe update:', e);
        }
      }
      setTimeout(updatePaymentButtonState, 0);
    } else {
      drawer.classList.remove('visible');
    }
  }
}

// Setup service worker per l'offline
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.error('Service Worker fallito:', err);
    });
  });
}

// Logica Animazione Anti-Frode (Canvas)
let dailySeed = 42; // Fallback seed
let animationFrameId: number | null = null;

async function fetchDailySeed() {
  try {
    const res = await fetch('/api/daily-seed');
    const data = await res.json();
    if (data.seed) {
      dailySeed = data.seed;
      console.log('Seed quotidiano anti-frode caricato:', dailySeed);
    }
  } catch (err) {
    console.warn('Impossibile caricare il seed dal server, uso fallback.', err);
  }
}

function initAntiFraudAnimation(seedValue: number) {
  const canvas = document.getElementById('antiFraudCanvas') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Imposta dimensioni a tutto schermo
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  let time = 0;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }

  function animate() {
    time += 0.01;
    ctx!.clearRect(0, 0, canvas.width, canvas.height);

    const waveCount = 12;
    const spacing = canvas.height / (waveCount + 1);

    // Disegna 12 onde neon parallele e sfasate a varie altezze per riempire tutto lo sfondo
    for (let i = 1; i <= waveCount; i++) {
      const centerY = spacing * i;
      const speedMultiplier = (i % 2 === 0 ? 1.0 : -1.0) * (0.4 + (i * 0.08));
      const amplitude = 35 + (i * 2);
      const hueOffset = i * 25; // Crea un gradiente arcobaleno dinamico lungo l'altezza

      ctx!.beginPath();
      ctx!.moveTo(0, centerY);

      // Step di 6px per ottimizzazione CPU/GPU su dispositivi mobili (iPad/Smartphone)
      for (let x = 0; x < canvas.width; x += 6) {
        const angle = x * 0.005 + (time * speedMultiplier) + (seedValue * 0.05);
        const y = Math.sin(angle) * amplitude +
                  Math.cos(x * 0.01 - time * 0.25 + seedValue) * (amplitude * 0.25) +
                  centerY;
        ctx!.lineTo(x, y);
      }

      const hue = (seedValue + time * 5 + hueOffset) % 360;
      ctx!.strokeStyle = `hsl(${hue}, 90%, 55%)`;
      ctx!.lineWidth = 3;
      ctx!.stroke();
    }

    animationFrameId = requestAnimationFrame(animate);
  }

  animate();
}

// Setup Stripe Payment Request Button
declare const Stripe: any;
let stripe: any;
let paymentRequest: any;

function initStripe(publishableKey: string) {
  if (typeof Stripe === 'undefined') {
    console.error('Stripe non è stato caricato.');
    return;
  }
  stripe = Stripe(publishableKey);

  try {
    paymentRequest = stripe.paymentRequest({
      country: 'IT',
      currency: 'eur',
      total: {
        label: 'Sauta Drink',
        amount: 0,
      },
      requestPayerName: false,
      requestPayerEmail: false,
    });

    const elements = stripe.elements();
    const prButton = elements.create('paymentRequestButton', {
      paymentRequest: paymentRequest,
      style: {
        paymentRequestButton: {
          type: 'buy',
          theme: 'dark',
          height: '50px',
        },
      },
    });

    paymentRequest.canMakePayment().then((result: any) => {
      console.log('Apple/Google Pay status:', result);
      if (result) {
        const container = document.getElementById('pay-btn');
        if (container) {
          container.replaceChildren();
          prButton.mount('#pay-btn');
        }
      }
    });
  } catch (err) {
    console.warn('Stripe non inizializzato correttamente (no wallet)', err);
  }

  if (paymentRequest) {
    paymentRequest.on('paymentmethod', async (ev: any) => {
    // 1. Chiama il nostro backend per creare il PaymentIntent
    try {
      if (!isTenantLoaded) {
        ev.complete('fail');
        return;
      }
      const consentEl = document.getElementById('compliance-consent') as HTMLInputElement;

      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalAmount: Math.round(state.total * 100), // in centesimi e strictly intero
          items: state.cart,
          digitalConsent: consentEl ? consentEl.checked : true
        })
      });
      const { clientSecret, sessionId, walletToken } = await response.json();

      // Salva il sessionId e walletToken nel Wallet locale
      if (sessionId && walletToken) {
        const items = readWalletCredentials();
        if (!items.some((item) => item.sessionId === sessionId)) {
          items.push({ sessionId, token: walletToken });
          localStorage.setItem('sauta_wallet', JSON.stringify(items));
        }
      }
      // 2. Conferma il pagamento con Stripe
      const { paymentIntent, error: confirmError } = await stripe.confirmCardPayment(
        clientSecret,
        { payment_method: ev.paymentMethod.id },
        { handleActions: false }
      );

      if (confirmError) {
        ev.complete('fail');
      } else {
        ev.complete('success');

        // Conferma al backend sincrona per sicurezza (senza dipendere dai webhook)
        try {
          await fetch('/api/checkout/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentIntentId: paymentIntent.id })
          });
        } catch (e) {
          console.warn('Backend confirmation failed, fallback to webhook', e);
        }

        if (paymentIntent.status === 'requires_action') {
          const { error } = await stripe.confirmCardPayment(clientSecret);
          if (error) {
             console.error('Pagamento fallito dopo SCA');
          } else {
             showSuccessUI();
          }
        } else {
          showSuccessUI();
        }
      }
    } catch (err) {
      ev.complete('fail');
    }
  });
  }
}

function showSuccessUI() {
  document.getElementById('checkout-drawer')?.classList.add('hidden');
  document.querySelector('.menu-section')?.classList.add('hidden');

  const successOverlay = document.getElementById('success-overlay');
  if (successOverlay) {
    successOverlay.classList.remove('hidden');
  }
}

(window as any).resetToMenu = () => {
  state.cart = {};
  state.total = 0;
  updateCartUI();

  document.getElementById('success-overlay')?.classList.add('hidden');
  document.querySelector('.menu-section')?.classList.remove('hidden');
  document.getElementById('checkout-drawer')?.classList.remove('hidden');
};

window.addEventListener('load', async () => {
  const loaded = await fetchVenueAndMenu();
  if (loaded) {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) {
        throw new Error('Configurazione Stripe non disponibile');
      }
      const data = await res.json();
      if (typeof data.stripePublishableKey !== 'string' || !data.stripePublishableKey) {
        throw new Error('Chiave pubblicabile Stripe non disponibile');
      }
      initStripe(data.stripePublishableKey);
    } catch (err) {
      console.error('Errore caricamento configurazione Stripe:', err);
      showTenantError('Pagamento temporaneamente non disponibile.');
    }
  }
  await fetchDailySeed();
});

// --- WALLET LOGIC WAVE 9B ---
(window as any).toggleWallet = () => {
  const modal = document.getElementById('wallet-modal');
  if (modal) {
    if (modal.classList.contains('hidden')) {
      modal.classList.remove('hidden');
      fetchWalletTickets();
    } else {
      modal.classList.add('hidden');
    }
  }
};

(window as any).requestConsumeToken = async (sessionId: string, walletToken: string, ticketId: string, productName: string) => {
  try {
    const response = await fetch('/api/wallet/consume-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, token: walletToken, ticketId }),
    });

    if (!response.ok) {
      alert('Impossibile autorizzare il consumo del biglietto.');
      return;
    }

    const { consumeToken } = await response.json();
    (window as any).openVerification(productName, consumeToken);
  } catch (err) {
    console.error('Errore richiesta consumeToken:', err);
    alert('Errore di connessione.');
  }
};

function sanitizeReceiptElement(receiptCard: Element): Element {
  const sanitized = receiptCard.cloneNode(true) as Element;
  sanitized.querySelectorAll('script, iframe, object, embed').forEach((element) => element.remove());
  sanitized.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (
        attribute.name.toLowerCase().startsWith('on') ||
        (['href', 'src'].includes(attribute.name.toLowerCase()) &&
          attribute.value.trim().toLowerCase().startsWith('javascript:'))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return sanitized;
}

(window as any).viewWalletReceipt = async (sessionId: string, walletToken: string) => {
  try {
    const response = await fetch('/api/wallet/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, token: walletToken }),
    });

    if (!response.ok) {
      alert('Impossibile accedere allo scontrino digitale autorizzato.');
      return;
    }

    const htmlText = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    const receiptCard = doc.querySelector('.receipt');
    if (!receiptCard) throw new Error('Struttura dello scontrino non valida');

    const modal = document.getElementById('receipt-modal');
    const modalBody = document.getElementById('receipt-modal-body');
    if (modal && modalBody) {
      modalBody.replaceChildren(document.importNode(sanitizeReceiptElement(receiptCard), true));
      modal.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Errore caricamento scontrino:', err);
    alert('Impossibile caricare lo scontrino digitale.');
  }
};

async function fetchWalletTickets() {
  const ticketsListEl = document.getElementById('wallet-tickets-list');
  const historyListEl = document.getElementById('wallet-history-list');
  if (!ticketsListEl || !historyListEl) return;

  const items = readWalletCredentials();

  if (items.length === 0) {
    ticketsListEl.textContent = 'Nessun drink attivo. Ordina qualcosa!';
    historyListEl.textContent = 'Nessuno scontrino archiviato.';
    return;
  }

  try {
    ticketsListEl.textContent = 'Caricamento biglietti...';
    historyListEl.textContent = 'Caricamento storico...';

    const batches: WalletCredential[][] = [];
    for (let index = 0; index < items.length; index += 20) {
      batches.push(items.slice(index, index + 20));
    }
    const responses = await Promise.all(batches.map((batch) =>
      fetch('/api/wallet/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: batch }),
      })
    ));
    if (responses.some((response) => !response.ok)) {
      ticketsListEl.textContent = 'Errore nel caricamento biglietti.';
      historyListEl.textContent = 'Errore nel caricamento storico.';
      return;
    }
    const payloads = await Promise.all(
      responses.map((response) => response.json() as Promise<{ sessions?: WalletResponseEntry[] }>)
    );
    const sessions = payloads.flatMap((payload) =>
      Array.isArray(payload.sessions) ? payload.sessions : []
    );
    if (!sessions || sessions.length === 0) {
      ticketsListEl.textContent = 'Nessun biglietto attivo.';
      historyListEl.textContent = 'Nessuno scontrino archiviato.';
      return;
    }

    ticketsListEl.replaceChildren();
    historyListEl.replaceChildren();

    let hasActiveTickets = false;
    let hasHistory = false;

    for (const itemData of sessions) {
      const { session, venue, tickets } = itemData;
      const walletToken = items.find((credential) => credential.sessionId === session.id)?.token || '';

      const validTickets = tickets.filter((ticket) => ticket.status === 'valid');
      for (const t of validTickets) {
        hasActiveTickets = true;
        const card = document.createElement('div');
        card.className = 'ticket-card';
        card.style.marginBottom = '12px';
        card.style.width = '100%';

        const info = document.createElement('div');
        info.className = 'ticket-info';
        const title = document.createElement('h3');
        title.textContent = t.productName;
        const sub = document.createElement('p');
        sub.textContent = 'Disponibile nel portafoglio';
        info.appendChild(title);
        info.appendChild(sub);

        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.style.marginTop = '15px';
        btn.style.width = '100%';
        btn.textContent = 'Consuma al banco 🎟️';
        btn.addEventListener('click', () => {
          (window as any).requestConsumeToken(session.id, walletToken, t.id, t.productName);
        });

        card.appendChild(info);
        card.appendChild(btn);
        ticketsListEl.appendChild(card);
      }

      hasHistory = true;
      const historyCard = document.createElement('div');
      historyCard.className = 'history-card';

      const historyInfo = document.createElement('div');
      historyInfo.className = 'history-info';
      const venueName = document.createElement('h4');
      venueName.textContent = venue.name;
      const meta = document.createElement('span');
      meta.className = 'history-meta';
      const dateStr = new Date(session.createdAt).toLocaleDateString('it-IT', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      meta.textContent = `${dateStr} • ${tickets.length} drink • €${(session.totalAmount / 100).toFixed(2)}`;
      historyInfo.appendChild(venueName);
      historyInfo.appendChild(meta);

      const receiptBtn = document.createElement('button');
      receiptBtn.className = 'btn-history-receipt';
      receiptBtn.textContent = 'Scontrino 📄';
      receiptBtn.addEventListener('click', () => {
        (window as any).viewWalletReceipt(session.id, walletToken);
      });

      historyCard.appendChild(historyInfo);
      historyCard.appendChild(receiptBtn);
      historyListEl.appendChild(historyCard);
    }

    if (!hasActiveTickets) {
      ticketsListEl.textContent = 'Nessun biglietto attivo.';
    }
    if (!hasHistory) {
      historyListEl.textContent = 'Nessuno scontrino archiviato.';
    }
  } catch (err) {
    console.error('Error fetching wallet:', err);
    ticketsListEl.textContent = 'Errore nel caricamento del wallet.';
    historyListEl.textContent = 'Errore nel caricamento dello storico.';
  }
}

// --- FULLSCREEN VERIFICATION LOGIC (ANTI-FRAUD) ---
(window as any).openVerification = (productName: string, token: string) => {
  const overlay = document.getElementById('verification-overlay');
  const title = document.getElementById('verification-title');
  const dateEl = document.getElementById('verification-date');
  const slider = document.getElementById('verify-slider') as HTMLInputElement;
  const fill = document.getElementById('verify-fill');
  const msg = document.getElementById('verify-msg');
  const swipeContainer = document.getElementById('verify-swipe-container');

  if (!overlay || !slider) return;

  // Ripristina bordo overlay eliminando il verde rimasto
  overlay.style.border = 'none';

  // Chiudi wallet per pulizia visiva
  const walletModal = document.getElementById('wallet-modal');
  if (walletModal) walletModal.classList.add('hidden');

  // Imposta dettagli ticket
  if (title) title.innerText = productName;
  if (dateEl) {
    const today = new Date();
    dateEl.innerText = today.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // Configura gestori swipe e checkbox preventivo
  slider.value = '0';
  if (fill) fill.style.width = '0%';
  if (msg) {
    msg.innerText = '';
    msg.classList.add('hidden');
  }

  if (swipeContainer) {
    swipeContainer.style.display = 'block';
    swipeContainer.classList.add('disabled');
  }
  slider.setAttribute('disabled', 'true');

  const unlockContainer = document.querySelector('.unlock-checkbox-container') as HTMLElement;
  if (unlockContainer) {
    unlockContainer.style.display = 'flex';
  }

  const unlockCheckbox = document.getElementById('verify-unlock-checkbox') as HTMLInputElement;
  if (unlockCheckbox) {
    unlockCheckbox.checked = false;
    unlockCheckbox.onchange = () => {
      if (unlockCheckbox.checked) {
        swipeContainer?.classList.remove('disabled');
        slider.removeAttribute('disabled');
      } else {
        swipeContainer?.classList.add('disabled');
        slider.setAttribute('disabled', 'true');
        slider.value = '0';
        if (fill) fill.style.width = '0%';
      }
    };
  }

  // Previeni memory leaks svuotando i vecchi listener prima del re-binding
  slider.oninput = null;
  slider.onchange = null;

  slider.oninput = () => {
    if (fill) fill.style.width = `${slider.value}%`;
  };

  slider.onchange = () => {
    if (parseInt(slider.value) < 95) {
      slider.value = '0';
      if (fill) fill.style.width = '0%';
    } else {
      (window as any).verifyConsume(token);
    }
  };

  // Mostra l'overlay e avvia l'animazione basata sul seed quotidiano verificato
  overlay.classList.remove('hidden');
  initAntiFraudAnimation(dailySeed);
};

(window as any).closeVerification = () => {
  const overlay = document.getElementById('verification-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  // Riapri il wallet
  const walletModal = document.getElementById('wallet-modal');
  if (walletModal) {
    walletModal.classList.remove('hidden');
    fetchWalletTickets(); // Ricarica lo stato
  }
};

(window as any).verifyConsume = async (token: string) => {
  const overlay = document.getElementById('verification-overlay');
  const msg = document.getElementById('verify-msg');
  const swipeContainer = document.getElementById('verify-swipe-container');
  const slider = document.getElementById('verify-slider') as HTMLInputElement;
  const fill = document.getElementById('verify-fill');
  const unlockContainer = document.querySelector('.unlock-checkbox-container') as HTMLElement;
  const unlockCheckbox = document.getElementById('verify-unlock-checkbox') as HTMLInputElement;

  // Mostra lo stato di caricamento (Niente verde immediato)
  if (swipeContainer) swipeContainer.style.display = 'none';
  if (unlockContainer) unlockContainer.style.display = 'none';

  if (msg) {
    msg.innerText = 'Convalida in corso... ⏳';
    msg.classList.remove('hidden');
    msg.style.color = '#ffffff';
  }
  if (overlay) {
    overlay.style.border = '4px solid rgba(255, 255, 255, 0.2)';
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // Alzato a 6 secondi per tollerare 4G lento

    const res = await fetch('/api/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumeToken: token }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error();
    }

    // Successo reale: Diventa verde DOPO la risposta del server
    if (overlay) {
      overlay.style.border = '4px solid #4ade80';
    }
    if (msg) {
      msg.innerText = 'Drink Convalidato! ✓';
      msg.style.color = '#4ade80';
    }

    // Svanisce dopo 1.5 secondi e ritorna al wallet
    setTimeout(() => {
      (window as any).closeVerification();
    }, 1500);

  } catch (err) {
    // FALLBACK SU ERRORE: Diventa rosso e fa riprovare
    if (overlay) {
      overlay.style.border = '4px solid #f87171';
    }
    if (msg) {
      msg.innerText = 'Errore di Connessione. Riprova.';
      msg.style.color = '#f87171';
    }

    setTimeout(() => {
      // Ripristina lo stato iniziale per consentire un nuovo tentativo
      if (overlay) overlay.style.border = 'none';
      if (msg) {
        msg.innerText = '';
        msg.classList.add('hidden');
      }

      // Mostra di nuovo gli elementi di sblocco
      if (swipeContainer) swipeContainer.style.display = 'block';
      if (unlockContainer) unlockContainer.style.display = 'flex';

      // Resetta e disabilita lo slider
      if (unlockCheckbox) unlockCheckbox.checked = false;
      swipeContainer?.classList.add('disabled');
      slider.setAttribute('disabled', 'true');
      slider.value = '0';
      if (fill) fill.style.width = '0%';
    }, 2500);
  }
};

function updatePaymentButtonState() {
  const consentEl = document.getElementById('compliance-consent') as HTMLInputElement;
  const payBtnContainer = document.getElementById('pay-btn');
  if (payBtnContainer) {
    if (consentEl && consentEl.checked) {
      payBtnContainer.classList.remove('disabled');
    } else {
      payBtnContainer.classList.add('disabled');
    }
  }
}

// Delegation per la checkbox di conformità
document.addEventListener('change', (e) => {
  const target = e.target as HTMLElement;
  if (target && target.id === 'compliance-consent') {
    updatePaymentButtonState();
  }
});

const LEGAL_CONTENT: Record<string, { title: string; html: string }> = {
  privacy: {
    title: 'Informativa Privacy (GDPR)',
    html: `
      <h4>1. Titolare del Trattamento</h4>
      <p>Il titolare del trattamento per il rapporto di vendita è la venue identificata nell'intestazione della PWA e nel documento commerciale. I dati legali e i recapiti privacy sono indicati nell'informativa completa della venue.</p>

      <h4>2. Dati Raccolti e Finalità (Privacy by Design)</h4>
      <p>Non chiediamo nome, email o telefono per usare il wallet. Identificativi di transazione e capability del wallet restano tuttavia dati tecnici pseudonimi e sono trattati per erogare il servizio, proteggerlo dagli abusi e adempiere agli obblighi fiscali.</p>

      <h4>3. Conservazione dei Dati (Data Retention)</h4>
      <p>La capability in chiaro viene salvata soltanto nel browser; il server conserva un hash non reversibile insieme agli identificativi di transazione. I dati fiscali e tecnici sono conservati per gli obblighi legali, la sicurezza e l'erogazione del servizio secondo i tempi indicati nell'informativa completa della venue.</p>

      <h4>4. Diritti dell'Interessato</h4>
      <p>Per esercitare i diritti applicabili puoi contattare la venue ai recapiti indicati nella sua informativa completa. In assenza di dati identificativi potrebbe essere necessario fornire elementi tecnici sufficienti a individuare la transazione.</p>
    `
  },
  cookie: {
    title: 'Cookie & Local Storage Policy',
    html: `
      <h4>1. Uso di Cookie e Memoria Locale</h4>
      <p>Questo sito web non utilizza cookie di profilazione o di terze parti a scopo pubblicitario o di tracciamento. Non raccogliamo dati di navigazione commerciali.</p>

      <h4>2. Cookie Tecnici e Local Storage</h4>
      <p>Utilizziamo la memoria locale del browser (<strong>localStorage</strong>) per salvare gli identificativi di sessione e le capability del wallet. I token di consumo a breve durata sono richiesti soltanto al momento dello swipe e non vengono conservati nel wallet.</p>

      <h4>3. Consenso</h4>
      <p>Essendo questi elementi tecnici strettamente necessari all'erogazione del servizio da te richiesto, ai sensi della Direttiva ePrivacy e delle Linee Guida del Garante Privacy del 10 giugno 2021, non è richiesto il consenso preventivo per l'attivazione di tali funzionalità.</p>
    `
  },
  terms: {
    title: 'Termini e Condizioni di Servizio',
    html: `
      <h4>1. Descrizione del Servizio</h4>
      <p>Sauta è una PWA white-label che permette di ordinare e pagare drink e consumazioni digitalmente presso i locali aderenti (discoteche, club) per poi riscuoterli al bancone senza fare la fila in cassa.</p>

      <h4>2. Ricezione dello Scontrino Digitale</h4>
      <p>Acquistando su Sauta, il cliente acconsente espressamente a ricevere il documento commerciale di vendita esclusivamente in formato elettronico digitale ai sensi del D.M. 07/12/2016. Lo scontrino è accessibile tramite link diretto nel Wallet PWA.</p>

      <h4>3. Uso dei Biglietti e Prevenzione Frodi</h4>
      <p>Ogni swipe richiede un token firmato, monouso e a breve scadenza. La riscossione avviene esclusivamente dinanzi al barman tramite lo slider "Swipe to Consume"; il server registra atomicamente il primo utilizzo valido e rifiuta i tentativi successivi.</p>
    `
  }
};

(window as any).openLegalModal = function(type: string) {
  const modal = document.getElementById('legal-modal');
  const titleEl = document.getElementById('legal-modal-title');
  const bodyEl = document.getElementById('legal-modal-body');

  if (modal && titleEl && bodyEl && LEGAL_CONTENT[type]) {
    titleEl.innerText = LEGAL_CONTENT[type].title;
    bodyEl.innerHTML = LEGAL_CONTENT[type].html;
    modal.classList.remove('hidden');
    modal.classList.add('visible');
  }
};

(window as any).closeLegalModal = function() {
  const modal = document.getElementById('legal-modal');
  if (modal) {
    modal.classList.remove('visible');
    modal.classList.add('hidden');
  }
};

(window as any).closeReceiptModal = () => {
  const modal = document.getElementById('receipt-modal');
  const modalBody = document.getElementById('receipt-modal-body');
  if (modal) {
    modal.classList.add('hidden');
  }
  if (modalBody) {
    modalBody.replaceChildren();
  }
};

(window as any).printReceipt = () => {
  window.print();
};

// --- ONBOARDING WELCOME MODAL LOGIC ---
document.addEventListener('DOMContentLoaded', () => {
  const onboardingSeen = localStorage.getItem('sauta_onboarding_seen');
  if (!onboardingSeen) {
    const onboardingModal = document.getElementById('onboarding-modal');
    if (onboardingModal) {
      onboardingModal.classList.remove('hidden');
      onboardingModal.classList.add('visible');
    }
  }
});

(window as any).closeOnboarding = () => {
  const onboardingModal = document.getElementById('onboarding-modal');
  if (onboardingModal) {
    onboardingModal.classList.remove('visible');
    onboardingModal.classList.add('hidden');
    localStorage.setItem('sauta_onboarding_seen', 'true');
  }
};

function bindStaticEventHandlers() {
  document.querySelectorAll<HTMLButtonElement>('[data-add-product]').forEach((button) => {
    button.addEventListener('click', () => {
      const productId = button.dataset.addProduct;
      if (productId) (window as any).addToCart(productId);
    });
  });

  document.getElementById('wallet-btn')?.addEventListener('click', () => (window as any).toggleWallet());
  document.getElementById('wallet-close-btn')?.addEventListener('click', () => (window as any).toggleWallet());
  document.getElementById('success-wallet-btn')?.addEventListener('click', () => {
    (window as any).toggleWallet();
    (window as any).resetToMenu();
  });
  document.getElementById('success-reset-btn')?.addEventListener('click', () => (window as any).resetToMenu());
  document.getElementById('fallback-pay-btn')?.addEventListener('click', () => {
    alert('Google/Apple Pay non disponibile su HTTP o dispositivo non supportato');
  });
  document.getElementById('verification-close-btn')?.addEventListener('click', () => (window as any).closeVerification());
  document.getElementById('legal-close-btn')?.addEventListener('click', () => (window as any).closeLegalModal());
  document.getElementById('receipt-close-btn')?.addEventListener('click', () => (window as any).closeReceiptModal());
  document.getElementById('receipt-footer-close-btn')?.addEventListener('click', () => (window as any).closeReceiptModal());
  document.getElementById('receipt-print-btn')?.addEventListener('click', () => (window as any).printReceipt());
  document.getElementById('onboarding-close-btn')?.addEventListener('click', () => (window as any).closeOnboarding());

  document.querySelectorAll<HTMLAnchorElement>('[data-legal-type]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const legalType = link.dataset.legalType;
      if (legalType) (window as any).openLegalModal(legalType);
    });
  });
}

bindStaticEventHandlers();
