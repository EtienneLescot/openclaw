# Stimm Voice — Supervisor JSON Contract Hardening Spec

## 1. Contexte

Le pipeline actuel fonctionne, mais le grand LLM (supervisor) renvoie encore parfois du texte libre au lieu du JSON contractuel attendu.

Effets observés :

- Décision `TRIGGER/NO_ACTION` parfois non parseable.
- Injections opportunistes moins déterministes.
- Le petit LLM peut rester en boucle de filler ("je vérifie avec mon superviseur") quand la réponse superviseur tarde.

## 2. Objectif

Rendre le comportement déterministe sans complexifier inutilement :

- Contrat de sortie JSON **obligatoire** côté supervisor.
- Prompt de contrat porté par **Stimm** (source d’autorité), transmis comme vrai `system prompt` provider.
- Pas de retry automatique (éviter les effets de bord).
- Timeout court + abandon propre pour casser les boucles de filler.

## 3. Non-objectifs

- Pas d’heuristiques métier (météo, outils spécifiques, etc.).
- Pas de backward compatibility pour anciens backends non structurés.
- Pas de logique de retry multi-passes.

## 4. Contrat attendu

Le supervisor doit renvoyer **un seul objet JSON** :

```json
{"action":"NO_ACTION"|"TRIGGER","text":"<string>","reason":"<short debug reason>"}
```

Règles :

- `action=NO_ACTION` -> `text` vide.
- `action=TRIGGER` -> `text` non vide.
- Aucune prose hors JSON.

## 5. Design retenu

### 5.1 Ownership

- La politique de décision et le format JSON restent définis dans Stimm (`ConversationSupervisor`).
- OpenClaw agit comme exécuteur : il reçoit `history` + `systemPrompt`, appelle le provider et renvoie la sortie brute.

### 5.2 Prompting path

- `systemPrompt` (Stimm) est transmis en vrai `extraSystemPrompt` à `runEmbeddedPiAgent(...)`.
- `history` est transmis comme prompt utilisateur séparé.

### 5.3 Parse policy

Dans Stimm :

- Parse strict JSON.
- Si non-JSON / invalide -> traité comme `NO_ACTION` avec raison de debug (`non_json_output`, `invalid_json`, etc.).
- Pas de deuxième appel.

## 6. Timeout court + abandon propre

### 6.1 Problème visé

Quand la réponse supervisor est lente, le petit LLM peut répéter des fillers en boucle.

### 6.2 Comportement cible

- Définir un délai court d’attente de décision supervisor par tour (ex: 4 à 6s).
- Si délai dépassé :
  - abandonner proprement l’attente de ce tour (pas de trigger tardif agressif),
  - marquer l’événement en log (`supervisor_timeout`),
  - laisser le petit LLM répondre sans rester bloqué en filler répété.

### 6.3 Exigence UX pour le petit LLM

Le filler doit rester honnête et court, puis sortir de l’attente :

- 1 à 2 phrases max.
- Pas de répétition identique sur plusieurs tours consécutifs.
- Si supervision indisponible/retardée : réponse utile minimale au lieu d’un nouveau filler.

## 7. Logging / Observabilité

Ajouter des signaux explicites :

- `contract_violation=non_json_output`
- `contract_violation=invalid_json`
- `supervisor_timeout=true`
- `decision=TRIGGER|NO_ACTION`
- `reason=<...>`

Objectif : diagnostic rapide sans inspecter toute la trace.

## 8. Plan d’implémentation

1. Renforcer le system prompt Stimm avec une clause "JSON only, no prose".
2. Garder parse strict dans Stimm, sans fallback texte libre.
3. Ajouter timeout par tour côté orchestration supervisor.
4. Sur timeout, abandonner proprement le tour et journaliser.
5. Ajuster instructions fast agent pour limiter les fillers répétitifs.
6. Ajouter tests :
   - sortie non JSON -> `NO_ACTION` + raison.
   - JSON valide `TRIGGER`.
   - timeout -> pas de boucle filler infinie.

## 9. Critères d’acceptation

- 0 réponse libre non-JSON acceptée comme trigger.
- Plus de boucles filler prolongées quand le supervisor est lent.
- Décisions lisibles dans les logs avec raison systématique.
- Aucun retry automatique introduit.
