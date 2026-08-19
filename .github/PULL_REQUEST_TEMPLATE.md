## What this changes

<!-- What was wrong or missing, and what this does about it. The commit
message body is usually the right text; link an issue if there is one. -->

## Why this way

<!-- Anything a reviewer would otherwise have to reconstruct: an approach
you rejected, a subtlety the tests encode, a tradeoff you took knowingly.
Delete this section if the change is self-evident. -->

## Checklist

- [ ] `npm test`, `npm run typecheck`, `npm run lint`, and
      `npm run format:check` pass locally
- [ ] Tests cover the specific thing that would otherwise break silently
- [ ] API surface changes are in `src/openapi.ts`, with
      `npm run collection` re-run
- [ ] User- or operator-visible changes are noted in `CHANGELOG.md`
- [ ] New configuration is documented in `.env.example`
