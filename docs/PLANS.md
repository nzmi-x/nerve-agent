# Plans — speculative designs & integration guides

This file holds designs for things **not yet built**. Once a plan is implemented, its guide
graduates to `docs/manual/<x>.md` and its decision to `docs/DECISIONS.md`. Until then, this is
the scratchpad: no rotted docs, no stale DECISIONS entries.

_No active plans right now._ The herdr integration graduated to [manual/herdr.md](manual/herdr.md)
+ [DECISIONS D51](DECISIONS.md) once Stage 1 shipped.

---

## Future plan template

When adding a new speculative design, follow this structure:

```
## <Title>

**Status:** spec (not built) | in progress | abandoned
**What:** one-line summary.

### Background
Context — why this matters, what gap it fills.

### Design
Key modules, data flow, integration points.

### Build plan
Numbered stages from minimum viable to full scope.

### What NOT to do
Anti-patterns that look tempting.

### Gotchas
Traps and edge cases.
```
