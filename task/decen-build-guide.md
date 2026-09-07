# Decentralized micro lending proj — Complete Project Build Guide
> Decentralized Blockchain-Based Micro-Lending Protocol for Gig Economy Workers
> Team: Poovannaraajan (23BCE0759) · Madhan Kumar (23BCB0065) · Sanjay Jaishankar (23BCB0078)

---

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Folder Structure](#3-folder-structure)
4. [Team Work Split](#4-team-work-split)
5. [Repo Setup — Do This Once](#5-repo-setup--do-this-once)
6. [Branch Strategy](#6-branch-strategy)
7. [Day-by-Day Build Plan](#7-day-by-day-build-plan)
8. [Review 2 — 65% Completion Target (Sep 9)](#8-review-2--65-completion-target-sep-9)
9. [Critical Handoff Points](#9-critical-handoff-points)
10. [Demo Script for Panel](#10-demo-script-for-panel)

---

## 1. Project Overview

Decentralized micro lending proj is a decentralized community lending protocol that enables collateral-free micro-loans for gig economy workers using on-chain reputation and verified income attestation.

- **No traditional backend** — smart contracts replace the server entirely
- **No database** — blockchain is the permanent, auditable data layer
- **No loan officer** — smart contracts automate approval, disbursement, and repayment
- **Deployed on** Ethereum Sepolia testnet (fake ETH, zero real-world value)

### How money flows

```
Investor deposits ETH via MetaMask
        │
        ▼
LendingPool smart contract receives ETH → mints GLP tokens to investor
        │
        ▼
Gig worker applies for loan → Chainlink fetches income data → CreditScore checked
        │
        ▼
Contract disburses ETH loan to worker's wallet automatically
        │
        ▼
Worker repays ETH + interest → CreditScore updated on-chain
        │
        ▼
Investor burns GLP tokens → receives original ETH + share of interest
```

---

## 2. Tech Stack

### Blockchain Layer
| Tool | Purpose |
|---|---|
| Solidity | Writing smart contracts |
| Hardhat | Local development, testing, deployment |
| Ethereum Sepolia Testnet | Live test network for demo |
| OpenZeppelin | Pre-audited ERC-20 and access control templates |
| Chainlink Functions | Oracle — fetches off-chain income data onto blockchain |

### Frontend Layer
| Tool | Purpose |
|---|---|
| React.js + Vite | UI for borrower and investor dashboards |
| Ethers.js | Connects React to deployed smart contracts |
| MetaMask | Wallet authentication and transaction signing |

### Development & Testing
| Tool | Purpose |
|---|---|
| Hardhat | Unit testing for contracts (also handles deployment) |
| Chai / Mocha | Testing libraries bundled with Hardhat |
| Alchemy / Infura | RPC provider — connects app to Sepolia network |
| Remix IDE | Quick browser-based Solidity prototyping |
| Etherscan (Sepolia) | View deployed contracts and transactions publicly |

---

## 3. Folder Structure

```
Decentralized micro lending proj/
│
├── contracts/                          # Poovannaraajan
│   ├── LendingPool.sol                 # Core — deposit, borrow, repay, withdraw
│   ├── GLPToken.sol                    # ERC-20 pool ownership token
│   ├── CreditScore.sol                 # On-chain reputation tracking
│   └── interfaces/
│       └── ILendingPool.sol            # Interface definitions
│
├── scripts/                            # Poovannaraajan
│   ├── deploy.js                       # Deploys all contracts to Sepolia in sequence
│   └── verify.js                       # Verifies contracts on Etherscan
│
├── test/                               # Poovannaraajan + Sanjay
│   ├── LendingPool.test.js
│   ├── GLPToken.test.js
│   └── CreditScore.test.js
│
├── chainlink/                          # Poovannaraajan
│   └── incomeVerification.js           # Chainlink Functions source code
│
├── frontend/                           # Madhan
│   ├── public/
│   │   └── index.html
│   └── src/
│       ├── components/
│       │   ├── ConnectWallet.jsx       # MetaMask connection button
│       │   ├── DepositForm.jsx         # Investor deposit UI
│       │   ├── BorrowForm.jsx          # Borrower loan application UI
│       │   ├── RepayForm.jsx           # Loan repayment UI
│       │   ├── CreditScoreCard.jsx     # Shows borrower's on-chain score
│       │   └── PoolAnalytics.jsx       # Pool stats dashboard
│       ├── hooks/
│       │   ├── useWallet.js            # MetaMask connection logic
│       │   └── useContract.js          # Ethers.js contract interaction
│       ├── utils/
│       │   └── contractHelpers.js      # ABI loading, deployed addresses
│       ├── contracts/                  # Auto-copied from artifacts after deploy
│       │   ├── LendingPool.json
│       │   ├── GLPToken.json
│       │   └── CreditScore.json
│       ├── App.jsx
│       └── main.jsx
│
├── hardhat.config.js                   # Hardhat + Sepolia network config
├── package.json
├── .env                                # NEVER commit this
├── .gitignore
└── README.md                           # Sanjay
```

---

## 4. Team Work Split

### Poovannaraajan — Smart Contracts + Blockchain Core

Owns the entire on-chain layer. This is the backend of the project.

**Contracts to write:**

`LendingPool.sol`
- `deposit()` — accepts ETH, calls GLPToken to mint tokens to sender
- `borrow()` — checks CreditScore, disburses ETH if eligible
- `repay()` — accepts ETH + interest, updates CreditScore
- `withdraw()` — burns GLP tokens, returns ETH + share of interest

`GLPToken.sol`
- Standard OpenZeppelin ERC-20
- Only LendingPool contract can mint or burn — not users directly

`CreditScore.sol`
- Tracks per-address: loans taken, repayments completed, income level
- Outputs a score 0–100
- Score increases after on-time repayment, decreases after default

`deploy.js` sequence:
1. Deploy GLPToken
2. Deploy CreditScore
3. Deploy LendingPool (pass GLPToken + CreditScore addresses into constructor)
4. Print all deployed addresses → share with Madhan

`chainlink/incomeVerification.js`
- Chainlink Functions source — fetches gig worker income from mock API
- Can use simulated data for Review 2, real oracle for Review 3

**Also owns:**
- Hardhat config and Sepolia network setup
- Unit tests for all three contracts
- Sharing ABI JSON files + contract addresses with Madhan after each deploy

---

### Madhan Kumar — Frontend + MetaMask Integration

Owns the entire user-facing layer. Works independently from Day 1 using mock data until contracts are deployed.

**Components to build:**

`ConnectWallet.jsx`
- Detects MetaMask installation
- Requests wallet connection
- Displays connected wallet address

`DepositForm.jsx`
- Input for ETH amount
- Calls `deposit()` on LendingPool contract
- Shows resulting GLP token balance after transaction confirms

`BorrowForm.jsx`
- Shows current credit score
- Input for loan amount
- Calls `borrow()` — shows success/failure based on score

`RepayForm.jsx`
- Shows outstanding loan amount + interest
- Calls `repay()` with correct ETH value

`CreditScoreCard.jsx`
- Reads score from CreditScore contract
- Visual indicator (0–100 bar or gauge)

`PoolAnalytics.jsx`
- Total ETH in pool
- Total active loans
- Global repayment rate
- User's GLP balance and pool share percentage

**Hooks:**

`useWallet.js`
- Handles MetaMask connection, account switching, network detection
- Alerts user if not on Sepolia

`useContract.js`
- Loads ABI from `/src/contracts/*.json`
- Creates ethers.js contract instances
- Exports ready-to-call functions: `deposit`, `borrow`, `repay`, `withdraw`

---

### Sanjay Jaishankar — Credit Scoring Logic + Testing + Documentation

Owns the reputation layer design, test coverage, and project documentation.

**Credit scoring formula to design:**

Inputs:
- Number of repayments completed on time → weight: 40%
- Total amount repaid historically → weight: 30%
- Monthly income (from Chainlink) → weight: 20%
- Membership duration → weight: 10%

Output: Score 0–100 mapped to borrow limits:
- 0–40 → not eligible
- 41–60 → eligible up to 0.05 ETH
- 61–80 → eligible up to 0.1 ETH
- 81–100 → eligible up to 0.2 ETH

**Test cases to write:**

`CreditScore.test.js`
- Score starts at 0 for new wallet
- Score increases correctly after repayment
- Score decreases after simulated default
- Borrow limit maps correctly to score band

`LendingPool.test.js`
- Deposit mints correct GLP amount
- Borrow fails if score below threshold
- Repay updates balance and score correctly
- Withdraw returns correct ETH amount

**Documentation (`README.md`):**
- Project description and problem statement
- Installation steps (`npm install`, `.env` setup)
- How to deploy to Sepolia
- How to run the frontend
- Architecture diagram (draw on Excalidraw, export as PNG, embed here)
- Team contributions

---

## 5. Repo Setup — Do This Once

### Poovannaraajan runs this (Day 1)

```bash
# Initialize project
mkdir Decentralized micro lending proj && cd Decentralized micro lending proj
npm init -y
npm install --save-dev hardhat
npx hardhat init
# Choose: Create a JavaScript project

# Install dependencies
npm install --save-dev @nomicfoundation/hardhat-toolbox
npm install @openzeppelin/contracts
npm install dotenv

# Create folder structure
mkdir -p contracts/interfaces scripts test chainlink
mkdir -p frontend/src/components frontend/src/hooks frontend/src/utils frontend/src/contracts
```

### Create `.gitignore`

```
node_modules/
.env
frontend/node_modules/
artifacts/
cache/
coverage/
```

### Create blank `.env`

```
PRIVATE_KEY=
SEPOLIA_RPC_URL=
ETHERSCAN_API_KEY=
```

Each teammate fills in their own values locally. This file is never committed.

### Push to GitHub

```bash
git init
git add .
git commit -m "init: project structure and dependencies"
git remote add origin https://github.com/yourusername/Decentralized micro lending proj.git
git push -u origin main
```

### Madhan and Sanjay clone and set up

```bash
git clone https://github.com/yourusername/Decentralized micro lending proj.git
cd Decentralized micro lending proj
npm install
# Then manually fill in your own .env values
```

### Madhan sets up frontend (after cloning)

```bash
cd frontend
npm create vite@latest . -- --template react
npm install
npm install ethers
git add .
git commit -m "init: vite react frontend with ethers"
git push
```

---

## 6. Branch Strategy

| Branch | Owner | Purpose |
|---|---|---|
| `main` | Everyone | Only stable, working code |
| `contracts` | Poovannaraajan | Smart contract development |
| `frontend` | Madhan | UI development |
| `credit-score` | Sanjay | Credit scoring logic and tests |

### Daily workflow

```bash
# Work on your branch
git checkout contracts          # or frontend / credit-score
# ... make changes ...
git add .
git commit -m "feat: add deposit function to LendingPool"
git push

# When something is stable, merge to main
git checkout main
git pull
git merge contracts
git push
```

### Rule: never push broken code to `main`

If your feature is half-done, keep it on your branch. Only merge when the specific feature works end-to-end.

---

## 7. Day-by-Day Build Plan

### Days 1–2 — Foundation

| Poovannaraajan | Madhan | Sanjay |
|---|---|---|
| Initialize Hardhat project | Clone repo, set up Vite + ethers | Clone repo, read project PDF |
| Write `GLPToken.sol` (full ERC-20) | Build `ConnectWallet.jsx` with mock data | Design credit scoring formula on paper |
| Deploy GLPToken to Sepolia | Show wallet address in UI | Write `CreditScore.sol` skeleton |
| Share ABI + address with Madhan | Connect to Sepolia network | Write first 3 test cases |

### Days 3–4 — Core Logic

| Poovannaraajan | Madhan | Sanjay |
|---|---|---|
| Write `LendingPool.sol` — deposit + withdraw | Build `DepositForm.jsx` against live contract | Implement scoring formula in `CreditScore.sol` |
| Write `CreditScore.sol` — basic score tracking | Show live GLP balance after deposit | Write `CreditScore.test.js` |
| Write `deploy.js` for all 3 contracts | Build `PoolAnalytics.jsx` with live data | Start `README.md` |
| Deploy all 3 contracts to Sepolia | Build `useContract.js` hook | Write `LendingPool.test.js` |

### Days 5–6 — Borrow + Repay Flow

| Poovannaraajan | Madhan | Sanjay |
|---|---|---|
| Implement `borrow()` with score gating | Build `BorrowForm.jsx` | Run all tests, fix failures |
| Implement `repay()` with interest | Build `RepayForm.jsx` | Update scoring weights based on test results |
| Begin `incomeVerification.js` for Chainlink | Build `CreditScoreCard.jsx` | Finalize `README.md` |
| Write unit tests for LendingPool | Full flow test on Sepolia | Prepare architecture diagram |

### Day 7 (Sep 8 — day before review) — Full Dry Run

Everyone together:
1. Madhan opens the frontend, connects MetaMask on Sepolia
2. Poovannaraajan deposits ETH → GLP tokens appear in wallet
3. Sanjay shows credit score on dashboard
4. Borrow flow runs — loan disburses on testnet
5. Repay flow runs — score updates visibly
6. Everyone can explain their own part to the panel

---

## 8. Review 2 — 65% Completion Target (Sep 9)

### Must be working

- `GLPToken.sol` deployed and live on Sepolia
- `LendingPool.sol` — deposit and withdraw fully functional
- `CreditScore.sol` — score updates after repayment
- Borrow function — works with score threshold gating
- MetaMask connects and shows wallet address
- Deposit flow end-to-end (ETH in → GLP tokens appear)
- Borrow flow end-to-end (form → loan disbursed on testnet)
- Pool analytics shows live on-chain data
- Credit score visible and updating in UI

### Partially done is acceptable

- Chainlink Functions — mock/simulated income data is fine for Review 2
- UI polish — functional over beautiful
- Edge case handling — happy path only is sufficient
- Gas optimization — not required at this stage

### Not expected yet

- Mainnet deployment
- Real Chainlink oracle integration
- KYC or identity layer
- Security audit
- Advanced analytics or reporting

---

## 9. Critical Handoff Points

### Handoff 1 — GLPToken ABI (Day 2)
Poovannaraajan → Madhan

After deploying GLPToken to Sepolia:
- Copy `artifacts/contracts/GLPToken.json` → `frontend/src/contracts/GLPToken.json`
- Share deployed contract address
- Madhan updates `contractHelpers.js` with this address

### Handoff 2 — All Contract ABIs (Day 4)
Poovannaraajan → Madhan

After deploying all 3 contracts:
- Copy all 3 ABI JSON files to `frontend/src/contracts/`
- Share all 3 deployed addresses
- Madhan connects all UI components to live contracts

### Handoff 3 — Scoring Formula (Day 3)
Sanjay → Poovannaraajan

After finalizing scoring formula on paper:
- Sanjay shares the formula weights and score-to-limit mapping
- Poovannaraajan implements it inside `CreditScore.sol`

These are the only three moments where one person's work blocks another. Everything else runs in parallel.

---

## 10. Demo Script for Panel

Full flow to run live in front of the Review 2 panel:

```
Step 1 — Madhan opens the frontend in browser
         Shows MetaMask connection button

Step 2 — Madhan connects MetaMask wallet (Sepolia network)
         Panel sees wallet address appear in UI

Step 3 — Madhan deposits 0.1 ETH into the pool
         MetaMask popup appears → confirm
         GLP tokens appear in wallet and UI updates

Step 4 — Sanjay points to CreditScoreCard
         Explains what the score means and how it's calculated

Step 5 — Madhan applies for a loan as a gig worker
         BorrowForm checks score → loan is approved
         ETH disbursed to wallet on Sepolia

Step 6 — Madhan repays the loan
         RepayForm submits repayment
         Credit score visibly increases on CreditScoreCard

Step 7 — Poovannaraajan shows Etherscan (Sepolia)
         All transactions visible publicly on-chain
         Proves no central server or database — everything is on blockchain
```

One-line summary for the panel:

> "A gig worker connects their MetaMask wallet, their on-chain credit score is evaluated, a loan is automatically approved and disbursed by the smart contract, and repayment updates their score in real time — all on Ethereum Sepolia testnet with no centralised intermediary."

---

*Last updated: September 2026 | VIT Vellore — BCSE497J Project I*
