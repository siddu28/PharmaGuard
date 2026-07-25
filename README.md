# 🛡️ PharmaGuard — AI Medication Safety Copilot

> **NitroStack Hackathon** · HealthTech & Life Sciences Track  
> Multi-factor clinical risk analysis MCP server that prevents dangerous drug prescriptions before they reach the patient.

---

## 📌 Problem Statement

Medical errors kill **~98,000 people annually** in the US alone. Drug-drug interactions, allergy cross-reactivity, renal contraindications, and pregnancy risks are preventable — but doctors juggle hundreds of drug combinations under time pressure.

**PharmaGuard** is an AI-powered MCP server that acts as a **real-time safety net** between the doctor's prescription intent and the patient. It intercepts natural language prescription requests, runs **7 parallel safety checks** across multiple clinical dimensions, and delivers a color-coded risk assessment with actionable alternatives.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     NitroStack Studio (Chat UI)                  │
│                                                                  │
│  Doctor: "Can I prescribe Ibuprofen 400mg for P001's headache?" │
└──────────────────────────┬──────────────────────────────────────┘
                           │ MCP Protocol (STDIO)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PharmaGuard MCP Server                        │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │  @Resource   │  │   @Prompt     │  │       @Tool (x12)      │  │
│  │  Patient DB  │  │  Workflow     │  │  Safety Check Engine   │  │
│  └──────┬──────┘  └──────┬───────┘  └────────────┬───────────┘  │
│         │                │                        │              │
│         ▼                ▼                        ▼              │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  Clinical Data Layer                         │ │
│  │  patients.json  ·  clinical-tables.ts  ·  6 lookup tables   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│         │                                        │               │
│         │              ┌─────────────────────────┤               │
│         ▼              ▼                         ▼               │
│  ┌────────────┐  ┌───────────┐  ┌─────────────────────────────┐ │
│  │ Gemini API │  │ OpenFDA   │  │       RxNorm (NIH)          │ │
│  │ (LLM)      │  │ (Drug DB) │  │  (Drug Classification)     │ │
│  └────────────┘  └───────────┘  └─────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              @Widget — Risk Dashboard (Next.js)              │ │
│  │  Color-coded report card rendered inline in Studio chat      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Complete Tool Orchestration Flow

When a doctor asks about prescribing a medication, the AI agent orchestrates **12 tools** in this sequence:

```
                         Doctor's Natural Language Input
                         "Prescribe Ibuprofen 400mg for P001"
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                                    ▼
          ┌─────────────────┐               ┌──────────────────────┐
  Step 1  │ get_patient_    │   Step 2      │ extract_clinical_    │
          │ profile (P001)  │               │ entities (Gemini)    │
          └────────┬────────┘               └──────────┬───────────┘
                   │                                    │
                   │  Patient Data:                     │  Extracted:
                   │  • Age: 65                         │  • Drug: Ibuprofen
                   │  • Allergies: [Penicillin]         │  • Dose: 400mg
                   │  • Meds: [Lisinopril]              │  • Frequency: TBD
                   │  • CrCl: 45 mL/min                │  • Reason: headache
                   │  • Pregnancy: N/A                  │
                   │                                    │
                   └────────────┬───────────────────────┘
                                │
                   ┌────────────▼────────────┐
          Step 3   │   7 PARALLEL SAFETY     │
                   │   CHECKS (simultaneous) │
                   └────────────┬────────────┘
                                │
           ┌────────┬───────┬───┴───┬────────┬────────┬────────┐
           ▼        ▼       ▼       ▼        ▼        ▼        ▼
      ┌─────────┐┌──────┐┌──────┐┌──────┐┌───────┐┌──────┐┌───────┐
      │Drug-Drug││Allergy││Disease││ Age  ││Duplic.││Renal ││Pregn. │
      │Interact.││Cross- ││Contra││Appro.││Therapy││Dose  ││Safety │
      │(OpenFDA)││React. ││indica.││(Beers)││(RxNorm)││Adj. ││(FDA)  │
      │         ││       ││      ││      ││       ││(CKD) ││Cat.   │
      └────┬────┘└───┬───┘└───┬──┘└───┬──┘└───┬───┘└──┬───┘└───┬───┘
           │         │        │       │       │       │        │
           └─────────┴────────┴───┬───┴───────┴───────┴────────┘
                                  │
                     ┌────────────▼────────────┐
            Step 4   │  aggregate_risk_score   │
                     │  Combines all flags     │
                     │  → safe / caution /     │
                     │    high_risk            │
                     └────────────┬────────────┘
                                  │
                    ┌─────────────┼──────────────┐
                    ▼                             ▼
          ┌─────────────────┐          ┌──────────────────┐
 Step 5   │ find_and_rank_  │ Step 6   │ generate_doctor_ │
 (if risky)│ alternatives   │          │ report           │
          │ (RxNorm + re-  │          │ (Template/Gemini)│
          │  check safety) │          │ + @Widget render │
          └─────────────────┘          └────────┬─────────┘
                                                │
                                   ┌────────────▼────────────┐
                                   │   🛡️ Risk Dashboard     │
                                   │   Widget (Next.js)      │
                                   │                         │
                                   │  🟢 SAFE / 🟡 CAUTION  │
                                   │  🔴 HIGH RISK           │
                                   │                         │
                                   │  Clinical Report +      │
                                   │  Recommended Action     │
                                   └─────────────────────────┘
```

---

## 📦 Project Structure

```
my-server/
├── .env                                # API keys (Gemini)
├── package.json                        # NitroStack + dependencies
├── tsconfig.json                       # TypeScript config
├── README.md                           # This file
│
├── src/
│   ├── index.ts                        # Server bootstrap (@McpApp)
│   ├── app.module.ts                   # Root module → PharmaGuardModule
│   ├── health/
│   │   └── system.health.ts            # Health check endpoint
│   │
│   ├── modules/
│   │   └── pharma-guard/
│   │       ├── pharma-guard.module.ts  # Module registration
│   │       ├── pharma-guard.tools.ts   # 12 MCP tools (core logic)
│   │       ├── pharma-guard.resources.ts # Patient data resources
│   │       ├── pharma-guard.prompts.ts # Workflow prompt templates
│   │       └── data/
│   │           ├── patients.json       # 3 mock EHR patient profiles
│   │           └── clinical-tables.ts  # 6 clinical lookup tables
│   │
│   └── widgets/
│       ├── widget-manifest.json        # Widget registration
│       ├── next.config.js              # Next.js widget config
│       ├── package.json                # Widget dependencies
│       └── app/
│           ├── layout.tsx              # Widget layout wrapper
│           └── risk-dashboard/
│               └── page.tsx            # Risk Dashboard widget (React)
```

---

## 🔧 All 12 MCP Tools

### Tier 1 — Core Safety Pipeline

| # | Tool | Input | Output | Data Source |
|---|------|-------|--------|-------------|
| 1 | `get_patient_profile` | `patientId` | Full clinical profile (demographics, labs, meds, allergies) | `patients.json` |
| 2 | `extract_clinical_entities` | Natural language text | Structured JSON: `{drugName, dosage, frequency, reason}` | **Gemini LLM** (+ regex fallback) |
| 3 | `check_drug_drug_interaction` | `newDrug` + `currentMedications[]` | Interaction list with severity + clinical context | **OpenFDA API** + local fallback table |
| 4 | `check_drug_allergy_conflict` | `newDrug` + `allergies[]` | Direct match + cross-reactivity check (e.g., Amoxicillin ↔ Penicillin) | Allergy cross-reactivity table |
| 5 | `check_disease_conflict` | `newDrug` + `diagnoses[]` | Contraindication flags with detail | Contraindication table |
| 6 | `check_age_appropriateness` | `newDrug` + `patientAge` | Beers Criteria flags for elderly/pediatric | Rule-based thresholds |
| 7 | `aggregate_risk_score` | All check results | `{overallRisk, riskScore, flaggedChecks[]}` — safe/caution/high_risk | Weighted scoring algorithm |
| 8 | `generate_doctor_report` | Patient + risk data | Professional clinical report with verdict + recommendations | **Gemini LLM** (+ template fallback) |

### Tier 2 — Advanced Checks

| # | Tool | Input | Output | Data Source |
|---|------|-------|--------|-------------|
| 9 | `check_duplicate_therapy` | `newDrug` + `currentMeds[]` | Same-class detection (e.g., Aspirin + Warfarin = both anticoagulants) | **RxNorm API** + local drug class table |
| 10 | `check_renal_dose_adjustment` | `newDrug` + `creatinineClearance` | CKD staging (1-5) + dose adjustment recommendation | Rule-based CKD thresholds |
| 11 | `find_and_rank_alternatives` | `unsafeDrug` + `patientId` | Ranked alternatives with safety scores (re-runs all checks per candidate) | **RxNorm API** + safety re-check |

### Tier 3 — Specialized

| # | Tool | Input | Output | Data Source |
|---|------|-------|--------|-------------|
| 12 | `check_pregnancy_safety` | `newDrug` + `pregnancyStatus` | FDA Category (A/B/C/D/X) + contraindication flag + recommendation | FDA pregnancy category table |

---

## 📊 Clinical Data Tables

| Table | Purpose | Entries |
|-------|---------|--------|
| `ALLERGY_CROSS_REACTIVITY_TABLE` | Maps drugs to allergy classes they trigger | 11 drugs |
| `CONTRAINDICATION_TABLE` | Maps drugs to diseases they conflict with | 10 drugs |
| `DRUG_INTERACTION_FALLBACK_TABLE` | Drug pair interactions (when OpenFDA is unavailable) | 8 drug pairs |
| `PREGNANCY_CATEGORY_TABLE` | FDA risk categories A through X | 12 drugs |
| `LOCAL_DRUG_CLASSES` | Therapeutic class groupings (RxNorm fallback) | 17 drugs |
| `ALTERNATIVE_DRUGS` | Safer replacement suggestions per drug | 9 drugs |

---

## 👥 Demo Patients & Expected Scenarios

### P001 — Mr. Sharma (Male, Age 65)
- **Profile:** Hypertension, allergy to Penicillin, on Lisinopril, CrCl 45 mL/min
- **Demo:** "Prescribe Ibuprofen 400mg for headache"
- **Expected Flags:**
  - 🔴 Drug-drug interaction (MAJOR): Ibuprofen + Lisinopril
  - 🔴 Renal: CrCl 45 = CKD Stage 3, Ibuprofen is nephrotoxic
  - 🟡 Elderly: Age 65, Beers Criteria flag
- **Recommended Alternative:** Acetaminophen (passes all checks)

### P002 — Ms. Fernandez (Female, Age 29)
- **Profile:** Pregnant (trimester 2), Migraine, allergy to Sulfa drugs, no current meds
- **Demo:** "Prescribe Ibuprofen for migraine"
- **Expected Flags:**
  - 🔴 Pregnancy: Ibuprofen = FDA Category D (contraindicated)
- **Recommended Alternative:** Acetaminophen (Category B, safe in pregnancy)

### P003 — Mr. Rao (Male, Age 80)
- **Profile:** CKD Stage 3, Atrial Fibrillation, Type 2 Diabetes, on Warfarin + Metoprolol + Metformin, CrCl 22 mL/min
- **Demo:** "Prescribe Aspirin 325mg for blood clot prevention"
- **Expected Flags:**
  - 🔴 Drug-drug interaction: Aspirin + Warfarin (major bleeding risk)
  - 🔴 Duplicate therapy: both are antithrombotics
  - 🔴 Disease conflict: Aspirin + CKD Stage 3
  - 🔴 Renal: CrCl 22 = CKD Stage 4, Aspirin is nephrotoxic
  - 🟡 Elderly: Age 80

---

## 🌐 External API Integration

| API | Purpose | Auth Required | Rate Limit |
|-----|---------|--------------|------------|
| **Google Gemini** (`v1beta`) | Entity extraction + report generation | API Key (in `.env`) | Free tier available |
| **OpenFDA** Drug Label | Drug-drug interaction lookup | None (public) | 240 requests/min |
| **RxNorm** (NIH) | Drug classification + alternative lookup | None (public) | No formal limit |

All APIs have **local fallback tables** so the system works fully offline.

---

## 🎨 Widget System

The **Risk Dashboard** widget renders inline in NitroStack Studio when `generate_doctor_report` is called:

- **🟢 Green banner** — SAFE TO PRESCRIBE
- **🟡 Yellow banner** — PROCEED WITH CAUTION
- **🔴 Red banner** — HIGH RISK — REVIEW REQUIRED

Built with `@nitrostack/widgets` SDK:
- `useWidgetSDK()` — Access tool output data
- `useTheme()` — Dark/light mode support
- `useWidgetState()` — Persistent expand/collapse state

---

## 🚀 Quick Start

```bash
# Navigate to my-server directory
cd my-server

# Install dependencies
npm install

# Set your Gemini API key in .env
echo "GEMINI_API_KEY=your_key_here" > .env

# Start development server
npm run dev
```

Then open **NitroStack Studio** → point to this project → try:
> "Can I prescribe Ibuprofen 400mg for patient P001's headache?"

---

## 🧰 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | NitroStack (`@nitrostack/core`) — Decorator-based MCP |
| **Language** | TypeScript (strict mode, ESM) |
| **LLM** | Google Gemini 2.0 Flash (entity extraction + reports) |
| **Drug Interactions** | OpenFDA `/drug/label` API |
| **Drug Classification** | RxNorm REST API (NIH, free, no key required) |
| **Validation** | Zod schemas on every tool input |
| **Widgets** | Next.js 14 + `@nitrostack/widgets` SDK |
| **Transport** | STDIO (dev) / STDIO + HTTP SSE (production) |

---

## 📁 Key Design Decisions

1. **Rule-based + LLM hybrid**: Clinical safety checks use deterministic rule-based logic (no hallucination risk). LLM is only used for natural language understanding and report formatting.

2. **Graceful degradation**: Every external API call (Gemini, OpenFDA, RxNorm) has a local fallback table. System works fully offline.

3. **Parallel execution**: All 7 safety checks run simultaneously, then aggregate. No sequential bottleneck.

4. **Re-check alternatives**: `find_and_rank_alternatives` doesn't just suggest drugs — it re-runs ALL safety checks on each candidate and ranks by score.

5. **Mock EHR**: `patients.json` simulates an EHR database with clinically realistic profiles designed to demonstrate different risk scenarios.

---

## 📄 License

Built for the NitroStack Hackathon 2026.
