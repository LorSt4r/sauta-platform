import './style.css';
import {
  generateIdempotencyKey,
  renderActivationPanel,
  renderOnboardingStepsTable,
  type OnboardingDetailsDto,
  type OnboardingStepDto,
} from './consoleOnboarding';

interface ConsoleUserResponse {
  user: {
    id: string;
    email: string;
    platformRole: string;
  };
  currentOrganizationId: string | null;
  memberships: Array<{
    venueId: string;
    venueName: string;
    organizationId: string | null;
    role: string;
  }>;
  onboardingVenues?: Array<{
    venueId: string;
    venueName: string;
    organizationId: string | null;
    role: string;
    onboardingStatus: string;
  }>;
}

interface ConsoleVenueResponse {
  venue: {
    id: string;
    name: string;
    role: string;
    permissions: string[];
  };
}

interface LogoutResponse {
  status: 'ok';
  logoutUrl: string;
}

let csrfToken: string | null = null;
let initialized = false;
let currentPlatformVenueId: string | null = null;
let platformLoadGeneration = 0;

interface ApiErrorBody {
  error?: string;
  reasonCode?: string;
}

interface OwnerOnboardingResponse {
  venue: {
    id: string;
    name: string;
    vatNumber: string | null;
    fiscalAddress: string | null;
    fiscalCity: string | null;
    fiscalZip: string | null;
    isActive: boolean;
  };
  onboardingStatus: string;
  steps: OnboardingStepDto[];
  readiness: {
    eligible: boolean;
    missingSteps: string[];
    reasonCodes: string[];
  };
}

async function fetchCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/csrf');
    if (!res.ok) return null;
    const data = await res.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  } catch {
    return null;
  }
}

async function renderConsoleState() {
  const statusBadge = document.getElementById('console-status-badge');
  const loginSection = document.getElementById('login-section');
  const dashboardSection = document.getElementById('dashboard-section');

  try {
    const res = await fetch('/api/console/me');

    if (!res.ok) {
      if (statusBadge) statusBadge.textContent = 'Non Autenticato';
      if (loginSection) loginSection.classList.remove('hidden');
      if (dashboardSection) dashboardSection.classList.add('hidden');
      return;
    }

    const data: ConsoleUserResponse = await res.json();
    await fetchCsrfToken();

    if (statusBadge) statusBadge.textContent = 'Autenticato';
    if (loginSection) loginSection.classList.add('hidden');
    if (dashboardSection) dashboardSection.classList.remove('hidden');

    const userEmailEl = document.getElementById('user-email-heading');
    if (userEmailEl) userEmailEl.textContent = data.user.email;

    const userRoleEl = document.getElementById('user-platform-role');
    if (userRoleEl) userRoleEl.textContent = `Ruolo Piattaforma: ${data.user.platformRole}`;

    const venueSelect = document.getElementById('venue-select') as HTMLSelectElement;
    if (venueSelect) {
      venueSelect.replaceChildren();
      for (const m of data.memberships) {
        if (!m.organizationId) continue;
        const opt = document.createElement('option');
        opt.value = m.organizationId;
        opt.textContent = `${m.venueName} (${m.role})`;
        if (m.organizationId === data.currentOrganizationId) {
          opt.selected = true;
        }
        venueSelect.appendChild(opt);
      }
      if (data.onboardingVenues) {
        for (const ov of data.onboardingVenues) {
          if (!ov.organizationId) continue;
          const opt = document.createElement('option');
          opt.value = ov.organizationId;
          opt.textContent = `[Onboarding] ${ov.venueName} (${ov.role})`;
          if (ov.organizationId === data.currentOrganizationId) {
            opt.selected = true;
          }
          venueSelect.appendChild(opt);
        }
      }
    }

    await loadVenueDetails();
    if (data.user.platformRole === 'PLATFORM_ADMIN') {
      await loadPlatformVenues();
    } else {
      hideElement('platform-onboarding-section');
    }
    await loadOwnerOnboarding();
  } catch (err) {
    if (statusBadge) statusBadge.textContent = 'Errore Connessione';
  }
}

function initEventListeners() {
  if (initialized) return;
  initialized = true;

  const loginBtn = document.getElementById('btn-login-authkit');
  const logoutBtn = document.getElementById('btn-logout-console');
  const switchBtn = document.getElementById('btn-switch-venue');
  const statusBadge = document.getElementById('console-status-badge');
  const platformCreateForm = document.getElementById(
    'platform-create-venue-form'
  ) as HTMLFormElement | null;
  const platformLoadButton = document.getElementById(
    'btn-load-platform-venue'
  );
  const reviewLegalButton = document.getElementById('btn-review-legal');
  const reviewOperationsButton = document.getElementById(
    'btn-review-operations'
  );
  const ownerProfileForm = document.getElementById(
    'owner-profile-form'
  ) as HTMLFormElement | null;

  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      window.location.href = '/api/auth/login';
    });
  }

  if (switchBtn) {
    switchBtn.addEventListener('click', async () => {
      const venueSelect = document.getElementById('venue-select') as HTMLSelectElement;
      const selectedOrgId = venueSelect?.value;
      if (!selectedOrgId || !csrfToken) return;

      try {
        const switchRes = await fetch('/api/auth/switch-organization', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({ organizationId: selectedOrgId }),
        });

        if (switchRes.ok) {
          await renderConsoleState();
        } else {
          alert('Impossibile cambiare organizzazione.');
        }
      } catch {
        alert('Errore durante il cambio organizzazione.');
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (!csrfToken) return;
      try {
        const logoutRes = await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            'x-csrf-token': csrfToken,
          },
        });
        if (!logoutRes.ok) {
          throw new Error('logout_failed');
        }

        const data = (await logoutRes.json()) as LogoutResponse;
        const logoutUrl = new URL(data.logoutUrl);
        if (logoutUrl.protocol !== 'https:' && logoutUrl.protocol !== 'http:') {
          throw new Error('logout_url_invalid');
        }

        csrfToken = null;
        window.location.assign(logoutUrl.toString());
      } catch {
        if (statusBadge) statusBadge.textContent = 'Errore Logout';
      }
    });
  }

  platformCreateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = getInputValue('platform-venue-name');
    const slug = getInputValue('platform-venue-slug').toLowerCase();
    const ownerEmail = getInputValue('platform-owner-email').toLowerCase();
    const response = await platformMutation<{
      venueId?: string;
      hostname?: string;
    }>('/api/platform/venues', 'POST', { name, slug, ownerEmail }, 'create-venue');
    if (!response.ok) {
      setMessage(
        'platform-create-message',
        formatApiFailure(response.body, 'Creazione draft non riuscita')
      );
      return;
    }
    currentPlatformVenueId = response.body.venueId ?? null;
    setMessage(
      'platform-create-message',
      `Draft creato: ${response.body.hostname ?? 'hostname in preparazione'}`
    );
    platformCreateForm.reset();
    await loadPlatformVenues(currentPlatformVenueId);
  });

  platformLoadButton?.addEventListener('click', async () => {
    const select = document.getElementById(
      'platform-venue-select'
    ) as HTMLSelectElement | null;
    currentPlatformVenueId = select?.value || null;
    await loadPlatformOnboardingDetails();
  });

  reviewLegalButton?.addEventListener('click', () =>
    reviewPlatformStep('LEGAL')
  );
  reviewOperationsButton?.addEventListener('click', () =>
    reviewPlatformStep('OPERATIONS')
  );

  ownerProfileForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await consoleMutation<OwnerOnboardingResponse>(
      '/api/console/onboarding/profile',
      'PATCH',
      {
        name: getInputValue('owner-profile-name'),
        vatNumber: getInputValue('owner-profile-vat'),
        fiscalAddress: getInputValue('owner-profile-address'),
        fiscalCity: getInputValue('owner-profile-city'),
        fiscalZip: getInputValue('owner-profile-zip'),
      }
    );
    if (!response.ok) {
      setMessage(
        'owner-profile-message',
        formatApiFailure(response.body, 'Aggiornamento profilo non riuscito')
      );
      return;
    }
    setMessage('owner-profile-message', 'Profilo aggiornato');
    await loadOwnerOnboarding();
  });
}

async function loadVenueDetails() {
  const venueNameEl = document.getElementById('current-venue-name');
  const venueRoleEl = document.getElementById('current-venue-role');
  const permsContainer = document.getElementById('current-venue-permissions');

  try {
    const res = await fetch('/api/console/venue');
    if (!res.ok) {
      if (venueNameEl) venueNameEl.textContent = 'Nessuna venue selezionata';
      if (venueRoleEl) venueRoleEl.textContent = 'Seleziona una venue dal menu a tendina.';
      if (permsContainer) permsContainer.replaceChildren();
      return;
    }

    const data: ConsoleVenueResponse = await res.json();
    if (venueNameEl) venueNameEl.textContent = data.venue.name;
    if (venueRoleEl) venueRoleEl.textContent = `Ruolo Venue: ${data.venue.role}`;

    if (permsContainer) {
      permsContainer.replaceChildren();
      for (const p of data.venue.permissions) {
        const badge = document.createElement('span');
        badge.className = 'console-badge';
        badge.style.background = 'rgba(16, 185, 129, 0.15)';
        badge.style.color = '#34d399';
        badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
        badge.textContent = p;
        permsContainer.appendChild(badge);
      }
    }
  } catch {
    if (venueNameEl) venueNameEl.textContent = 'Errore caricamento venue';
  }
}

function hideElement(id: string): void {
  document.getElementById(id)?.classList.add('hidden');
}

function showElement(id: string): void {
  document.getElementById(id)?.classList.remove('hidden');
}

function setMessage(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function getInputValue(id: string): string {
  const input = document.getElementById(id) as HTMLInputElement | null;
  return input?.value.trim() ?? '';
}

function setInputValue(id: string, value: string | null): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (input) input.value = value ?? '';
}

function formatApiFailure(body: ApiErrorBody, fallback: string): string {
  return body.reasonCode ? `${fallback}: ${body.reasonCode}` : fallback;
}

async function readResponseBody<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}

async function ensureCsrfToken(): Promise<string | null> {
  return csrfToken ?? fetchCsrfToken();
}

async function consoleMutation<T>(
  url: string,
  method: 'POST' | 'PATCH',
  body?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; body: T & ApiErrorBody }> {
  const csrf = await ensureCsrfToken();
  if (!csrf) {
    return {
      ok: false,
      status: 403,
      body: { reasonCode: 'csrf_unavailable' } as T & ApiErrorBody,
    };
  }
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'x-csrf-token': csrf,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await readResponseBody<T & ApiErrorBody>(response),
  };
}

async function platformMutation<T>(
  url: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown> | undefined,
  action: string
): Promise<{ ok: boolean; status: number; body: T & ApiErrorBody }> {
  const csrf = await ensureCsrfToken();
  if (!csrf) {
    return {
      ok: false,
      status: 403,
      body: { reasonCode: 'csrf_unavailable' } as T & ApiErrorBody,
    };
  }
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'x-csrf-token': csrf,
      'idempotency-key': generateIdempotencyKey(action),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await readResponseBody<T & ApiErrorBody>(response),
  };
}

async function loadPlatformVenues(preferredVenueId?: string | null): Promise<void> {
  const generation = ++platformLoadGeneration;
  const section = document.getElementById('platform-onboarding-section');
  const select = document.getElementById(
    'platform-venue-select'
  ) as HTMLSelectElement | null;
  if (!section || !select) return;

  const response = await fetch('/api/platform/venues');
  if (!response.ok) {
    hideElement('platform-onboarding-section');
    return;
  }
  const data = await readResponseBody<{
    venues: Array<{ id: string; name: string; isActive: boolean }>;
  }>(response);
  if (generation !== platformLoadGeneration) return;
  showElement('platform-onboarding-section');
  select.replaceChildren();
  for (const venue of data.venues) {
    const option = document.createElement('option');
    option.value = venue.id;
    option.textContent = `${venue.name} — ${venue.isActive ? 'ACTIVE' : 'ONBOARDING'}`;
    select.appendChild(option);
  }
  const target =
    preferredVenueId ??
    currentPlatformVenueId ??
    data.venues[0]?.id ??
    null;
  if (target) {
    select.value = target;
    currentPlatformVenueId = target;
    await loadPlatformOnboardingDetails();
  } else {
    currentPlatformVenueId = null;
    setMessage('platform-onboarding-summary', 'Nessuna venue disponibile');
  }
}

async function loadPlatformOnboardingDetails(): Promise<void> {
  if (!currentPlatformVenueId) return;
  const requestedVenueId = currentPlatformVenueId;
  const response = await fetch(
    `/api/platform/venues/${encodeURIComponent(requestedVenueId)}/onboarding`
  );
  if (currentPlatformVenueId !== requestedVenueId) return;
  if (!response.ok) {
    const body = await readResponseBody<ApiErrorBody>(response);
    setMessage(
      'platform-onboarding-summary',
      formatApiFailure(body, 'Onboarding non disponibile')
    );
    return;
  }
  const details = await readResponseBody<OnboardingDetailsDto>(response);
  setMessage(
    'platform-onboarding-summary',
    `${details.venue.name} — ${details.onboardingStatus}`
  );
  const stepsContainer = document.getElementById('platform-onboarding-steps');
  if (stepsContainer) {
    renderOnboardingStepsTable(stepsContainer, details.steps);
  }
  const readinessContainer = document.getElementById(
    'platform-readiness-panel'
  );
  if (readinessContainer) {
    renderActivationPanel(readinessContainer, details.readiness, async () => {
      const result = await platformMutation<ApiErrorBody>(
        `/api/platform/venues/${encodeURIComponent(details.venue.id)}/activate`,
        'POST',
        undefined,
        `activate-${details.venue.id}`
      );
      setMessage(
        'platform-onboarding-summary',
        result.ok
          ? 'Venue attivata'
          : formatApiFailure(result.body, 'Attivazione negata')
      );
      await loadPlatformOnboardingDetails();
    });
  }
  renderInvitations(details);
  renderProvisioningCommands(details);
}

function appendActionButton(
  container: HTMLElement,
  label: string,
  handler: () => Promise<void>
): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-console btn-secondary-console';
  button.textContent = label;
  button.addEventListener('click', () => {
    void handler();
  });
  container.appendChild(button);
}

function renderInvitations(details: OnboardingDetailsDto): void {
  const container = document.getElementById('platform-invitations');
  if (!container) return;
  container.replaceChildren();
  if (details.invitations.length === 0) {
    container.textContent = 'Nessun invito';
    return;
  }
  for (const invitation of details.invitations) {
    const card = document.createElement('div');
    card.className = 'console-card';
    card.style.marginBottom = '10px';
    const summary = document.createElement('p');
    summary.textContent = `${invitation.email} — ${invitation.role} — ${invitation.status}`;
    card.appendChild(summary);
    const actions = document.createElement('div');
    actions.className = 'console-actions';
    if (
      invitation.workosInvitationId &&
      (invitation.status === 'PENDING' || invitation.status === 'SENT')
    ) {
      appendActionButton(actions, 'Reinvia', async () => {
        if (!window.confirm(`Reinviare l'invito a ${invitation.email}?`)) return;
        const result = await platformMutation<ApiErrorBody>(
          `/api/platform/invitations/${encodeURIComponent(invitation.id)}/resend`,
          'POST',
          undefined,
          `resend-${invitation.id}`
        );
        setMessage(
          'platform-onboarding-summary',
          result.ok
            ? 'Invito reinviato'
            : formatApiFailure(result.body, 'Reinvio non completato')
        );
        await loadPlatformOnboardingDetails();
      });
      appendActionButton(actions, 'Revoca', async () => {
        if (!window.confirm(`Revocare l'invito a ${invitation.email}?`)) return;
        const result = await platformMutation<ApiErrorBody>(
          `/api/platform/invitations/${encodeURIComponent(invitation.id)}/revoke`,
          'POST',
          undefined,
          `revoke-${invitation.id}`
        );
        setMessage(
          'platform-onboarding-summary',
          result.ok
            ? 'Invito revocato'
            : formatApiFailure(result.body, 'Revoca non completata')
        );
        await loadPlatformOnboardingDetails();
      });
    }
    card.appendChild(actions);
    container.appendChild(card);
  }
}

function renderProvisioningCommands(details: OnboardingDetailsDto): void {
  const container = document.getElementById(
    'platform-provisioning-commands'
  );
  if (!container) return;
  container.replaceChildren();
  if (details.provisioningCommands.length === 0) {
    container.textContent = 'Nessun comando';
    return;
  }
  for (const command of details.provisioningCommands) {
    const card = document.createElement('div');
    card.className = 'console-card';
    card.style.marginBottom = '10px';
    const summary = document.createElement('p');
    summary.textContent = `${command.kind} — ${command.status} — tentativi ${command.attempts}`;
    card.appendChild(summary);
    if (command.lastReasonCode) {
      const reason = document.createElement('p');
      reason.textContent = command.lastReasonCode;
      card.appendChild(reason);
    }
    if (
      command.status === 'RETRYABLE' &&
      command.kind !== 'RESEND_INVITATION'
    ) {
      appendActionButton(card, 'Riprova', async () => {
        const result = await platformMutation<ApiErrorBody>(
          `/api/platform/provisioning/${encodeURIComponent(command.id)}/retry`,
          'POST',
          undefined,
          `retry-${command.id}`
        );
        setMessage(
          'platform-onboarding-summary',
          result.ok
            ? 'Retry accodato'
            : formatApiFailure(result.body, 'Retry non accodato')
        );
        await loadPlatformOnboardingDetails();
      });
    }
    container.appendChild(card);
  }
}

async function reviewPlatformStep(
  step: 'LEGAL' | 'OPERATIONS'
): Promise<void> {
  if (!currentPlatformVenueId) return;
  const result = await platformMutation<ApiErrorBody>(
    `/api/platform/venues/${encodeURIComponent(currentPlatformVenueId)}/onboarding/review`,
    'PATCH',
    { step, status: 'READY' },
    `review-${step.toLowerCase()}-${currentPlatformVenueId}`
  );
  setMessage(
    'platform-onboarding-summary',
    result.ok
      ? `Review ${step} registrata`
      : formatApiFailure(result.body, `Review ${step} non registrata`)
  );
  await loadPlatformOnboardingDetails();
}

async function loadOwnerOnboarding(): Promise<void> {
  const response = await fetch('/api/console/onboarding');
  if (!response.ok) {
    hideElement('owner-onboarding-section');
    return;
  }
  const details = await readResponseBody<OwnerOnboardingResponse>(response);
  showElement('owner-onboarding-section');
  setMessage(
    'owner-onboarding-summary',
    `${details.venue.name} — ${details.onboardingStatus}`
  );
  const steps = Object.fromEntries(
    details.steps.map((step) => [step.step, step])
  );
  const container = document.getElementById('owner-onboarding-steps');
  if (container) renderOnboardingStepsTable(container, steps);
  setInputValue('owner-profile-name', details.venue.name);
  setInputValue('owner-profile-vat', details.venue.vatNumber);
  setInputValue('owner-profile-address', details.venue.fiscalAddress);
  setInputValue('owner-profile-city', details.venue.fiscalCity);
  setInputValue('owner-profile-zip', details.venue.fiscalZip);
}

window.addEventListener('load', () => {
  initEventListeners();
  renderConsoleState();
});
