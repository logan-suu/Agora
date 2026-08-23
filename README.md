# 🏛️ Agora

### *Where AI Agents debate, code, and ship — under your command.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Harness](https://img.shields.io/badge/DeepSeek_Harness-Orchestration-4A6CF7)](https://github.com/deepseek-ai/harness)
[![MCP](https://img.shields.io/badge/MCP-Tools_Protocol-FF6B00)](https://modelcontextprotocol.io)
[![Status](https://img.shields.io/badge/Status-Phase_0_%E2%80%A2_Prototype-orange)](https://github.com/your-username/agora)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🎯 What is Agora?

**Agora is not another "ChatGPT wrapper".**

It is a **multi-agent software development team** that communicates through **group chats**, just like a real engineering squad. You—the human—act as the **Team Leader**, while AI Agents take on specialized roles: *PM, Architect, Coder, Tester, and Reviewer*.

> **The core bet**: True parallel coding + human-led arbitration + strict context engineering = an AI team you can actually trust to ship code.

---

## ✨ Design Highlights (Why this matters for your portfolio)

Agora stands on **four engineering pillars** that directly address the known failure modes of multi-agent systems (famously criticized in *"Don't Build Multi-Agents"*):

### 1. 📐 Context as Engineering (Not Raw Logs)
Naive multi-agent systems flood every agent with the entire chat history—causing token explosion and context dilution. **Agora flips this.**
- Implements **Role Projection**: Each Agent reads only a structured slice of the global state (e.g., the Coder sees the Subtask + failing tests, but *not* the PM's full debate).
- Uses Harness's `agent/pre-step` to **overwrite** the model's input queue with this projection, physically blocking raw group-chat logs from ever reaching the LLM.

### 2. ⚡ True Parallelism + Cooperative Preemption
To feel like a real team, agents must work *simultaneously*.
- Each worker runs in an isolated Harness sub-agent with its own **git worktree** (file isolation).
- **Cooperative Preemption**: When the Leader changes their mind mid-task, workers run to a **safe point** (Step boundary), checkpoint their state, and resume with the new context. No hard-killing LLMs, no corrupted state.

### 3. 🧑‍⚖️ Leader as the Sole Authority (No Auto-Consensus)
Automatic consensus among agents leads to endless debate and "hallucinated compromises."
- Agents can raise **Objections** (Blocking vs. Advisory).
- **Blocking** issues (e.g., Leader contradicts existing requirements) trigger a global pause and escalate to the Leader for a final, irreversible ruling via the `HumanGate`.

### 4. 🏗️ Project-level Tenancy (Isolation + Knowledge Distillation)
- **Default Deny**: Projects are independent worlds (separate sandboxes, rosters, and state).
- **Controlled Imports**: Reuse goes through an audited `ImportRecord` (snapshot copy, not live link).
- **Knowledge Base**: Each project has a *Refined Layer* (injected into context) and an *Archive Layer* (RAG-accessible). The **Librarian** (Coordinator delegate) distills insights from finished tasks, but **Write-Block** is enforced until human approval (`/approve-kb`).

---

## 🧠 Architecture Overview

```mermaid
graph TD
    User[👤 Leader] <--> UI[📱 Group Chat UI / Global Inbox]
    UI <--> Orchestrator[🧠 Orchestrator (Self-research)]
    
    Orchestrator --> Coordinator[⚙️ Coordinator]
    Coordinator -->|Routes| WorkerPool[💼 Worker Pool]
    
    subgraph WorkerPool [Parallel Execution]
        Worker1[Worker 1: Coder] --> Harness1[Harness Loop]
        Worker2[Worker 2: Tester] --> Harness2[Harness Loop]
        Worker3[Worker 3: Architect] --> Harness3[Harness Loop]
    end
    
    Harness1 --> Projection[📋 Context Projection (Overwrite)]
    Harness1 --> MCP[🔧 MCP Tools]
    
    MCP --> Sandbox[📦 Sandbox Adapter]
    Sandbox -->|Phase 0| Local[📁 Local Temp Dir]
    Sandbox -->|Future| Docker[🐳 Docker + Worktrees]
    
    Orchestrator <--> State[💾 Shared State / Reducers]
    State <--> KB[📚 Knowledge Base]
    
    Coordinator -->|Blocking| HumanGate[🚦 Human Gate]
    HumanGate --> User
```

---

## 🛠️ Tech Stack

| Layer                   | Technology                                                   |
| :---------------------- | :----------------------------------------------------------- |
| **Language**            | TypeScript (Node 20+)                                        |
| **Single-Agent Kernel** | DeepSeek Harness (ReAct loop, event sourcing, `ctx.subagents`) |
| **Orchestration**       | Self-researched lightweight runtime (4 generic nodes)        |
| **Communication**       | MCP (Model Context Protocol) SDK                             |
| **Sandbox**             | **Phase 0**: `fs.mkdtemp` + `child_process` (Mock) <br> **Future**: Docker (dockerode) + Git Worktree (simple-git) |
| **Frontend**            | Next.js / React (SSE + HTTP POST)                            |
| **Monorepo**            | pnpm workspaces                                              |

---

## 🚀 Quick Start (Phase 0 Prototype)

> **Note**: Phase 0 is the "skeleton" phase. It runs entirely **locally** without Docker or Git worktrees to ensure the agent loop and state machine work flawlessly first. It uses temporary directories for sandboxing.

### Prerequisites
- Node.js 20+
- pnpm (`npm install -g pnpm`)
- An API Key for DeepSeek/OpenAI (Harness provider)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/agora.git
cd agora

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env and add your LLM API keys
```

### Run the Phase 0 Test (LRU Cache)
```bash
# Build the core packages
pnpm build

# Run the single-file coding task (Coder writes LRU Cache, Tester validates)
pnpm start:phase-0
```

**What you should see**:
1. `Coordinator` creates the task.
2. `Coder` generates the LRU Cache code in a temporary directory.
3. `Tester` runs the validation tests.
4. If tests fail, the loop sends it back to `Coder`.
5. On success, the system finalizes and outputs the result.

---

## 📁 Project Structure (Monorepo)

```
agora/
├── packages/
│   ├── core/               # State, Orchestrator, Coordinator, Projection
│   ├── executors/          # HarnessExecutor, ExternalExecutor (interface)
│   ├── sandbox/            # SandboxManager (LocalTemp adapter + future Docker)
│   ├── tools/              # MCP Servers (fs, git, test, lint, sandbox)
│   ├── comm/               # Message Bus, Channels, Inbox
│   └── roles/              # RoleSpec definitions (PM, Coder, etc.)
├── apps/
│   └── web/                # Next.js frontend (Future phase)
├── docs/
│   ├── 多 Agent 代码协作系统 · 项目蓝图.md
│   └── 多 Agent 代码协作系统 · 详细设计方案.md
├── .env.example
├── package.json
└── README.md
```

---

## 🗺️ Roadmap

| Phase | Goal                                                         | Status            |
| :---- | :----------------------------------------------------------- | :---------------- |
| **0** | **Skeleton**: State machine + Harness single agent + Local temp sandbox. Run a single-file LRU Cache task. | **🚧 In Progress** |
| 1     | Add Docker sandbox + core MCP tools (read/write/run).        | 📅 Planned         |
| 2     | Full team: PM, Architect, Tester, Reviewer + test/review loops. | 📅 Planned         |
| 3     | Context engineering: Handoffs, decision ledger, authority levels. | 📅 Planned         |
| 4     | Adaptive orchestration: Complexity-based routing (Tier 0/1/2). | 📅 Planned         |
| 5     | Group Chat UI + Leader commands.                             | 📅 Planned         |
| 6     | Multi-channel communication (Sub-groups, threads).           | 📅 Planned         |
| 7     | Role hot-swapping (Recruitment / Offboarding with mandatory handoffs). | 📅 Planned         |
| 8     | Human Gate + Arbitration UI.                                 | 📅 Planned         |
| 9     | True Parallelism: Async workers + Cooperative Preemption.    | 📅 Planned         |
| 10    | "Thick" Executors (OpenHands) + Product polish.              | 📅 Planned         |

---

## 🧠 Key Architectural Decisions (Phase 0)

To keep the project moving fast, we made 5 crucial engineering trade-offs (2026-08-23):

1.  **Context Overwrite**: We *overwrite* the Harness `messages` queue in `pre-step` rather than appending, ensuring raw chat logs never hit the model.
2.  **Thin-Only Executors**: All agents use the Harness "thin" loop until Phase 10. The `external` type is a reserved placeholder.
3.  **Knowledge Base Write-Block**: Writing to the KB is disabled until a double-gate passes (All tests green + `/approve-kb` command).
4.  **Terminate & Fork**: When stuck in `HumanGate`, the process is **terminated** (releasing resources) and later **forked** from the checkpoint, rather than being "paused."
5.  **Local Mock Sandbox**: Phase 0 uses Node.js `tmp` directories and `child_process` instead of Docker/Git to accelerate development.

*These decisions are documented in `docs/` with `[2026-08-23 Architecture Decision]` markers.*

---

## 🤝 Contributing

This is a personal portfolio project for the 2026 Autumn Recruitment season. While I'm not accepting external PRs right now, feedback and star-gazing are highly appreciated!

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---

## 🌟 If You're a Recruiter or Interviewer...

Agora was designed to demonstrate **system-level thinking** rather than just calling a chat API. It tackles:
- **Engineering trade-offs**: Why choose Harness over LangGraph? Why Self-researched orchestration?
- **Concurrency**: Cooperative preemption with LLMs (no hard-killing).
- **Context Management**: Projection views to prevent "lost-in-the-middle."
- **Product Sense**: A "Group Chat" interface makes AI behavior transparent and controllable.

I'd love to walk you through the code or the design decisions in an interview.

---

**Built with ☕ and 🧠 for the love of building AI that actually works.**