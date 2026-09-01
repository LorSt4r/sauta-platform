/**
 * Sauta Console Onboarding Dashboard & Controls (Wave 9C.0C)
 *
 * Safety Mandates:
 * 1. Rendering of dynamic/remote data MUST use textContent or document.createElement (NO innerHTML with remote input).
 * 2. All mutation requests include x-csrf-token and Idempotency-Key headers.
 */

export interface OnboardingStepDto {
  step: 'OWNER' | 'LEGAL' | 'DOMAIN' | 'CATALOG' | 'STRIPE' | 'FISCAL' | 'OPERATIONS';
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'BLOCKED' | 'READY';
  source: 'SYSTEM' | 'OWNER' | 'PLATFORM_REVIEW' | 'PROVIDER' | 'LEGACY_BACKFILL';
  reasonCode: string | null;
}

export interface OnboardingDetailsDto {
  venue: {
    id: string;
    name: string;
    isActive: boolean;
    workosOrganizationId: string | null;
    vatNumber: string | null;
    fiscalAddress: string | null;
    fiscalCity: string | null;
    fiscalZip: string | null;
  };
  onboardingStatus: string;
  steps: Record<string, OnboardingStepDto>;
  storedSteps: Array<OnboardingStepDto>;
  invitations: Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    workosInvitationId: string | null;
    sentAt: string | null;
  }>;
  provisioningCommands: Array<{
    id: string;
    kind: string;
    status: string;
    attempts: number;
    lastReasonCode: string | null;
  }>;
  readiness: {
    eligible: boolean;
    missingSteps: string[];
    reasonCodes: string[];
  };
}

export function generateIdempotencyKey(action: string): string {
  const normalizedAction = action.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `idemp_${normalizedAction}_${crypto.randomUUID()}`;
}

export function renderOnboardingStepsTable(
  container: HTMLElement,
  steps: Record<string, OnboardingStepDto>
) {
  container.replaceChildren();

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.marginTop = '12px';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
  headerRow.style.textAlign = 'left';

  const headers = ['Step', 'Stato', 'Fonte', 'Motivo / Detail'];
  for (const hText of headers) {
    const th = document.createElement('th');
    th.style.padding = '8px';
    th.textContent = hText;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const stepList = ['OWNER', 'LEGAL', 'DOMAIN', 'CATALOG', 'STRIPE', 'FISCAL', 'OPERATIONS'];

  for (const stepName of stepList) {
    const stepData = steps[stepName] || {
      step: stepName,
      status: 'NOT_STARTED',
      source: 'SYSTEM',
      reasonCode: null,
    };

    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid rgba(255, 255, 255, 0.05)';

    const tdName = document.createElement('td');
    tdName.style.padding = '8px';
    tdName.style.fontWeight = 'bold';
    tdName.textContent = stepName;
    tr.appendChild(tdName);

    const tdStatus = document.createElement('td');
    tdStatus.style.padding = '8px';
    const badge = document.createElement('span');
    badge.className = 'console-badge';
    badge.textContent = stepData.status;
    if (stepData.status === 'READY') {
      badge.style.background = 'rgba(16, 185, 129, 0.2)';
      badge.style.color = '#34d399';
    } else if (stepData.status === 'BLOCKED') {
      badge.style.background = 'rgba(239, 68, 68, 0.2)';
      badge.style.color = '#f87171';
    }
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    const tdSource = document.createElement('td');
    tdSource.style.padding = '8px';
    tdSource.style.fontSize = '0.9rem';
    tdSource.style.color = '#a1a1aa';
    tdSource.textContent = stepData.source;
    tr.appendChild(tdSource);

    const tdReason = document.createElement('td');
    tdReason.style.padding = '8px';
    tdReason.style.fontSize = '0.85rem';
    tdReason.style.color = '#d4d4d8';
    tdReason.textContent = stepData.reasonCode || '-';
    tr.appendChild(tdReason);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.appendChild(table);
}

export function renderActivationPanel(
  container: HTMLElement,
  readiness: { eligible: boolean; missingSteps: string[]; reasonCodes: string[] },
  onActivate: () => void
) {
  container.replaceChildren();

  const title = document.createElement('h4');
  title.style.margin = '0 0 8px 0';
  title.textContent = 'Stato Attivazione Venue';
  container.appendChild(title);

  const statusPara = document.createElement('p');
  statusPara.style.fontSize = '0.95rem';
  statusPara.style.margin = '4px 0';

  if (readiness.eligible) {
    statusPara.style.color = '#34d399';
    statusPara.textContent = '✅ Venue pronta per l\'attivazione!';
  } else {
    statusPara.style.color = '#f87171';
    statusPara.textContent = '❌ Attivazione non eleggibile. Step mancanti: ' + readiness.missingSteps.join(', ');
  }
  container.appendChild(statusPara);

  if (readiness.reasonCodes.length > 0) {
    const reasonsUl = document.createElement('ul');
    reasonsUl.style.margin = '8px 0';
    reasonsUl.style.paddingLeft = '20px';
    reasonsUl.style.fontSize = '0.85rem';
    reasonsUl.style.color = '#a1a1aa';

    for (const code of readiness.reasonCodes) {
      const li = document.createElement('li');
      li.textContent = code;
      reasonsUl.appendChild(li);
    }
    container.appendChild(reasonsUl);
  }

  const activateBtn = document.createElement('button');
  activateBtn.id = 'btn-attempt-activation';
  activateBtn.className = 'btn-console btn-primary-console';
  activateBtn.style.marginTop = '12px';
  activateBtn.textContent = 'Richiedi Attivazione Venue';
  activateBtn.addEventListener('click', onActivate);
  container.appendChild(activateBtn);
}
