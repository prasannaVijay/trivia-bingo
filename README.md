# Trivia Bingo 🎉

A local-first multiplayer trivia party game. The host runs a game on a laptop, guests scan a QR code on the same Wi-Fi, and everyone plays from their phone. OpenAI generates a fresh question pack before each game. **Generation needs an internet connection and API key; gameplay remains local on Wi-Fi after the questions are approved.** Built-in questions provide an offline fallback.

## Quick start

Requirements: **Node.js 20.19+ or 22.12+** (Node.js 24 recommended), npm, and a laptop connected to the same Wi-Fi as the players.

1. Extract the project ZIP into a folder.
2. In a terminal inside the `trivia-bingo` folder, run:

   ```bash
   npm install
   npm run build
   npm start
   ```

3. To enable AI trivia generation, copy `.env.example` to `.env` in the project folder and add your own OpenAI API key:

   ```dotenv
   OPENAI_API_KEY=your-api-key-here
   OPENAI_MODEL=gpt-4.1-mini
   ```

   Leave `.env` on your laptop. **Never commit it to GitHub.** `.gitignore` excludes it. An API key is billed through the OpenAI API account separately from a ChatGPT subscription.

4. Restart `npm start` after changing `.env`. On the host laptop, visit **http://localhost:3000** in Chrome, Edge, or Safari.
5. Select topics, difficulty (easy, medium, hard or mixed), board size, question count and timer (15, 30, 45 or 60 seconds).
6. In **AI Question Studio**, generate a pack, preview all answers, edit mistakes or regenerate individual questions. You can also load the built-in questions when offline.
7. Click **Approve & open lobby**. Display or screen-share the host screen.
8. Players scan the QR code, join using a nickname, and wait for the host to start.

**Tip:** Install dependencies and build before the party. Generate and approve questions while online. Once the game reaches the lobby, gameplay does not require AI or the internet.

### If npm is pointing to a corporate package registry

This project uses public npm packages. If npm tries to download from a corporate registry you cannot reach, run the following from the project folder to override that registry for this command without changing global npm settings:

```bash
npm ci --registry=https://registry.npmjs.org/ --replace-registry-host=always
```

Check for a project-specific `.npmrc` or environment variable if that still does not work.

### AI generation and review

- New games use OpenAI's Responses API with strict structured JSON output.
- Each generated question includes its topic, difficulty, four answers, one correct answer and an explanation.
- The server validates structure, rejects duplicate choices and duplicate questions, and shuffles answer positions.
- The host can **edit or regenerate any question**. Generating another pack replaces the current draft, but never changes an already-approved game.
- Generation requests are authenticated to the host game room. New game creation is restricted to localhost by default to prevent other Wi-Fi users from consuming API quota.
- If generation fails, use **Use offline questions** in Question Studio. The fixed 160-question bank remains available.
- AI can still generate factual errors. The host should check answers before approval.

### Windows terminal

Open PowerShell in the extracted folder and run the three commands above. When Windows Firewall asks, allow Node.js access on **private networks**. Ensure the Wi-Fi network is configured as Private, not Public, if permitted by your local security settings.

### macOS terminal

Open Terminal in the extracted folder and run the same commands. Allow incoming local connections to Node.js if prompted.

## The QR code does not work on a phone

The host server prints a Wi-Fi URL on startup, such as `http://192.168.1.42:3000`. The QR code points to a join link using the detected laptop IP address.

Check that:

- Both devices are on the same Wi-Fi and can communicate with each other. Guest networks or "AP/client isolation" often block this.
- The host laptop is awake, with `npm start` still running.
- Your firewall permits Node.js on the private network.
- The displayed QR link has the laptop's **LAN IPv4 address**, rather than `localhost`, `127.0.0.1`, a Docker/VPN address, or an unreachable network interface.

If your laptop has multiple network interfaces or LAN detection fails, override the address **before** starting the server:

Windows PowerShell:

```powershell
$env:JOIN_BASE_URL = "http://192.168.1.42:3000"
npm start
```

macOS/Linux:

```bash
JOIN_BASE_URL=http://192.168.1.42:3000 npm start
```

Replace `192.168.1.42` with the laptop's real private IPv4 address. On Windows, find it with `ipconfig`; on macOS, use System Settings > Wi-Fi > Details. The player phones should open that exact local address.

**Remote participants:** A LAN address only works for people who can reach that LAN. Screen-sharing the host screen over a video call will not enable remote players to join. A future cloud-hosted version would support that.

## Game rules

- All players see the same timed multiple-choice question (four options).
- The host's question timer runs on the server. Answers are accepted once per player, until the deadline.
- After the answer reveal, each player who got it right sees **two random empty cells** on their Bingo board and chooses one to mark.
- If they don't choose before the 8-second marking period expires, the server picks one of the two cells for them.
- Each completed row, column, or diagonal is one Bingo line. A 4×4 board has 10 possible lines; a 5×5 board has 12.
- The live host leaderboard stays visible and refreshes after each marking period.
- All questions play out before overall winners are declared.

### Awards

1. **Overall Champions:** Most completed Bingo lines, then most correct trivia answers, then fastest average correct-answer response time.
2. **Trivia Masters:** Most correct answers, with response time breaking ties.
3. **Fastest Fingers:** Fastest average response time on correct answers, among players who correctly answered at least 50% of the questions.

Each awards section displays up to three winners. If nobody completes a Bingo line, the overall ranking falls back to trivia accuracy.

### Included content

Eight topic categories: general knowledge, science, geography, history, movies and TV, music, sports and technology. OpenAI generates fresh questions each game. The existing 160-question bank is available as an offline fallback.

## Developer commands

```bash
npm run build    # Typecheck React/TypeScript and package static assets
npm test         # Unit tests for lines, random choices, ranking, question selection
npm run smoke    # Local multiplayer integration test (~19 seconds)
npm run smoke:ai # End-to-end Question Studio test with a fake AI service (~6 seconds)
npm start        # Host the production app on 0.0.0.0:3000
```

For development, run `npm run dev:server` and `npm run dev:client` in separate terminals. The Vite frontend will be at http://localhost:5173 and proxies API and Socket.IO traffic to the backend at port 3000. For a real Wi-Fi game, use the **production** `npm start` server on port 3000.

## Architecture

- **React + TypeScript + Vite** for the responsive host and player interfaces.
- **Express + Socket.IO** for a server-authoritative game session and real-time room messaging.
- **Pure game engine functions** in `server/engine.js` for card choices, completed-line counting, ranking and question selection.
- **Bundled question bank** in `server/questions.js`.
- **OpenAI question generator** in `server/ai.js`, using the Responses API and structured output validation. API secrets stay on the Node server.
- **In-memory active sessions** while the server runs. Completed game results are written to `data/<ROOMCODE>-results.json` (not uploaded anywhere).

The server never sends the correct answer to clients during the question phase. The host has an unguessable session token, and each player has a separate reconnect token saved in that phone's browser. Duplicate or late answers and unauthorized Bingo marks are rejected on the server.

## MVP limitations

- New players cannot join after the game starts. Players who joined earlier can reconnect using the same browser.
- The game pauses only if the host process is stopped; **active sessions do not survive a server restart**. Finished results are saved.
- The laptop must stay awake. Multiple games can be created in one process, but each game has its own room.
- Arbitrary custom topic names, pause/resume, sound effects and cloud hosting are future enhancements. Hosts can already edit any generated question.
- Up to 120 players are accepted per room. For a large event, do a practice run on the actual Wi-Fi first.

## License

This project was created for the requesting user's own use. Review and adapt the bundled trivia questions for your audience before hosting a public event.
