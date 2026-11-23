# Roadmap

## 1.3

The work for 1.3 (bug fixes, reliability, features, testing) is in
[PLAN-1.3.md](PLAN-1.3.md).

## Later

### Language and access

| Feature | What it does | Effort |
|---|---|---|
| **French translation** | Counter, panel, tooltip, popup and backup page in French, picked automatically from the browser's language. Other languages can be added the same way. | M |
| **Keyboard and screen readers** | The counter's panel and the seek bar details reachable with the keyboard, with proper labels. | S |

## Considered, not planned

| Idea | Why not (for now) |
|---|---|
| Sound from clips | Clips keep their sound and can be lined up exactly with the VOD (tested), but they covered only 2.1% of the muted time on a test VOD, and most need video matching to line up. A lot of work for little sound. |
| Other Twitch servers | Tested 29 server addresses: the four that serve VODs all share the same storage, so a deleted original is gone everywhere. |
| An always-on saver (script for a NAS or server) | The only way to save while your computer is off, but it's a separate program to build and run. |
| Smaller saves with another audio format | Twitch's player only plays AAC in these files; 64 kbps is already close to the floor. |
| Mobile site (`m.twitch.tv`) | Uses a different player: a lot of work for little use. |
