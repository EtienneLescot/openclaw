# Handover — Bug double voix stimm-voice

**Date :** 24 février 2026  
**Branche :** `add-stimm`  
**Repo openclaw :** `EtienneLescot/openclaw`  
**Repo stimm :** `/home/etienne/Documents/repos/stimm` (local, pas sur GitHub)

---

## Symptôme

Quand l'utilisateur parle une fois (ex: "Bonjour"), **deux réponses TTS distinctes** sont jouées simultanément avec des textes différents :

- "Bonjour ! Je vérifie les informations..."
- "Bonjour! Je vérifie avec mon superviseur..."

L'UI web affiche aussi "You: Bonjour" **deux fois**.

---

## Architecture

```
Browser (WebRTC)
    │
LiveKit Cloud
    │
agent.py  (Python, livekit-agents 1.4.3)
    ├─ stimm.VoiceAgent      → fast LLM path (VAD → STT → gpt-4o-mini → TTS)
    └─ OpenClawSupervisor    → HTTP POST /stimm/supervisor → OpenClaw gateway → big LLM
```

L'`entrypoint(ctx)` dans `agent.py` délègue entièrement à `stimm.worker.make_entrypoint()`.

---

## Cause racine identifiée (confirmée dans le code source)

`livekit/agents/voice/audio_recognition.py` a **deux chemins** qui appellent `on_final_transcript` :

1. **Ligne ~362** — `_on_stt_event` : fire direct quand le plugin STT envoie `FINAL_TRANSCRIPT`
2. **Ligne ~302** — `commit_user_turn` : promeut le transcript intérimaire en final si STT n'a pas encore résolu

→ Les deux émettent l'événement `user_input_transcribed` → deux `publish_transcript` → deux appels LLM → deux TTS.

---

## Fixes déjà appliqués (mais **non encore validés par les logs**)

### 1. `stimm/worker.py` — dedup dans `_on_transcript`

```python
_last_final: list[Any] = ["", 0.0]
_FINAL_DEDUP_WINDOW_S = 2.0

@session.on("user_input_transcribed")
def _on_transcript(ev):
    is_final = bool(ev.is_final)
    text = ev.transcript or ""
    logger.info("[TRANSCRIPT] is_final=%s text=%r agent_state=%s current_speech=%s", ...)
    if is_final:
        now = time.monotonic()
        if text == _last_final[0] and now - _last_final[1] < _FINAL_DEDUP_WINDOW_S:
            logger.info("[TRANSCRIPT] DEDUP DROP final=%r", text)
            return
        _last_final[0] = text
        _last_final[1] = now
        logger.info("[TRANSCRIPT] PASS final=%r → publish_transcript", text)
    asyncio.ensure_future(agent.publish_transcript(text, partial=not is_final))
```

### 2. `stimm/conversation_supervisor.py` — dedup dans `on_transcript`

```python
async def on_transcript(self, msg):
    text = msg.text.strip()
    last_user = next((t for t in reversed(self._history) if t.role == "user"), None)
    if last_user is not None and last_user.text.strip() == text:
        logger.info("[SUPERVISOR] DEDUP DROP user transcript=%r", text)
        return
    logger.info("[SUPERVISOR] ACCEPT user transcript=%r (history_len=%d)", text, len(self._history))
    self._push("user", text)
```

### 3. `stimm/voice_agent.py` — guard `current_speech` + `_reply_trigger_inflight`

```python
def _can_trigger_context_reply_now(self, session):
    if agent_state not in {"idle", "listening"}: return False
    if user_state == "speaking": return False
    if getattr(session, "current_speech", None) is not None: return False  # ← ajouté
    return True

async def _generate_reply_from_current_context(self):
    if self._reply_trigger_inflight:
        logger.info("[VOICE_AGENT] generate_reply SKIPPED (inflight)")
        return
    self._reply_trigger_inflight = True
    try:
        logger.info("[VOICE_AGENT] generate_reply TRIGGERED ...")
        session.generate_reply(...)
    finally:
        self._reply_trigger_inflight = False
```

### 4. `stimm/worker.py` — re-apply INFO level dans l'entrypoint

Ajouté juste après `await ctx.connect(...)` :

```python
import logging as _logging
for _n in ("stimm", "openclaw"):
    _logging.getLogger(_n).setLevel(_logging.INFO)
```

### 5. `agent.py` — FileHandler pour les logs stimm

livekit-agents en mode `dev` utilise `watchfiles.arun_process` qui lance `entrypoint(ctx)` dans un **sous-process fork**. Ce sous-process ne partage pas le stdout/stderr capturé par Node.js. Solution : `FileHandler` hérité par le fork.

```python
_file_handler = logging.FileHandler("/tmp/stimm-agent.log", mode="a")
for _pkg in ("stimm", "openclaw"):
    lg = logging.getLogger(_pkg)
    lg.setLevel(logging.INFO)
    lg.addHandler(_file_handler)
    lg.propagate = False
```

### 6. `agent-process.ts` — freePort + logFile

- `AgentProcess.freePort(8081)` tué avant chaque spawn (évite `OSError: address already in use`)
- Logs Python aussi écrits dans `/tmp/stimm-agent.log` via `createWriteStream`
- `LIVEKIT_LOG_LEVEL: "debug"` dans l'env du process enfant

---

## État du test au moment du handover

**Logs fonctionnels** : le `FileHandler` dans `agent.py` a été validé par un test `multiprocessing` — les logs du sous-process fork apparaissent bien dans `/tmp/stimm-agent.log`.

**Test réel en cours** : une session voix a été effectuée avec double TTS confirmé, mais `grep -E "\[TRANSCRIPT\]|\[SUPERVISOR\]|\[VOICE_AGENT\]" /tmp/stimm-agent.log` retournait vide → le `FileHandler` n'était **pas encore** dans `agent.py` à ce moment.

Le dernier changement (`FileHandler` dans `agent.py`) **n'a pas encore été testé en conditions réelles**.

---

## Prochaine étape : collecter les logs

```bash
# Terminal 1 — observer les logs en temps réel
tail -f --retry /tmp/stimm-agent.log

# Terminal 2 — démarrer le gateway
rm -f /tmp/stimm-agent.log
openclaw voice:start --channel web
```

Attendre `registered worker` dans les logs openclaw, puis ouvrir l'URL (copier-coller, le QR code est cassé), dire "Bonjour" et filtrer :

```bash
grep -E "\[TRANSCRIPT\]|\[SUPERVISOR\]|\[VOICE_AGENT\]|Bonjour|generate_reply" /tmp/stimm-agent.log
```

### Ce qu'on attend voir

| Log                                               | Signification                                |
| ------------------------------------------------- | -------------------------------------------- |
| `[TRANSCRIPT] PASS final='Bonjour'`               | 1er transcript passe → normal                |
| `[TRANSCRIPT] DEDUP DROP final='Bonjour'`         | dedup worker.py fonctionne ✅                |
| `[SUPERVISOR] ACCEPT` × 1                         | entre dans l'historique → normal             |
| `[SUPERVISOR] DEDUP DROP`                         | si le 2e arrive quand même au supervisor     |
| `[VOICE_AGENT] generate_reply TRIGGERED` × 2      | → **c'est encore là que ça double**          |
| `[VOICE_AGENT] generate_reply SKIPPED (inflight)` | → guard `_reply_trigger_inflight` fonctionne |

### Si on voit deux `[VOICE_AGENT] generate_reply TRIGGERED`

Le guard `_reply_trigger_inflight` ne couvre pas le cas où les deux appels arrivent depuis **deux événements indépendants** (ex : `user_input_transcribed` + `supervisor_context_updated`). Il faudra alors identifier d'où vient le second déclenchement et ajouter un verrou asyncio.

### Si on ne voit aucun `[TRANSCRIPT]`

Vérifier que stimm est bien installé en editable :

```bash
cd extensions/stimm-voice/python
.venv/bin/pip show stimm | grep Location
# doit pointer vers /home/etienne/Documents/repos/stimm
```

Si non : `.venv/bin/pip install -e /home/etienne/Documents/repos/stimm`

---

## Fichiers modifiés

| Fichier                                       | Changement                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `extensions/stimm-voice/python/agent.py`      | FileHandler logging + délégation à `make_entrypoint`                         |
| `extensions/stimm-voice/src/agent-process.ts` | `freePort(8081)`, log vers `/tmp/stimm-agent.log`, `LIVEKIT_LOG_LEVEL=debug` |
| `stimm/src/stimm/worker.py`                   | `room_input_options` param, dedup `_on_transcript`, re-apply INFO level      |
| `stimm/src/stimm/conversation_supervisor.py`  | dedup dans `on_transcript`                                                   |
| `stimm/src/stimm/voice_agent.py`              | `current_speech` guard, `_reply_trigger_inflight`, logs `[VOICE_AGENT]`      |

**Rappel :** après toute modif dans `stimm/`, vérifier que stimm est installé en editable (pas besoin de rebuild — c'est du Python). Après toute modif dans `extensions/stimm-voice/src/`, faire `pnpm build`.

---

## Commandes utiles

```bash
# Rebuild openclaw
pnpm build

# Vérifier le venv stimm
extensions/stimm-voice/python/.venv/bin/pip show stimm

# Tuer un zombie sur le port 8081
fuser -k 8081/tcp

# Logs en direct
tail -f --retry /tmp/stimm-agent.log

# Filtrer les marqueurs de diagnostic
grep -E "\[TRANSCRIPT\]|\[SUPERVISOR\]|\[VOICE_AGENT\]" /tmp/stimm-agent.log
```
