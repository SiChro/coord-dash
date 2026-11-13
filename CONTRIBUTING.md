# Contributing to coord-dash

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Security problems:** report them privately (GitHub security advisory on this repository),
  never in a public issue.
- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Keep the server free of npm dependencies. Vendored browser libraries need a compatible license.

## Making a change

1. Fork, create a branch, keep the change focused on one thing.
2. Run the tests: `npm test`, and `npm run test:browser` if you touched the page
   (see the README, "Development and tests").
3. New source files start with:
   ```
   // SPDX-License-Identifier: AGPL-3.0-only
   // Copyright (C) 2026 Simon Chromec
   ```
4. Never commit secrets, real hostnames, tailnet names, session names or personal paths.
   Machine-specific values belong in the gitignored config files.
5. Open a pull request that explains what changed and why, and includes the CLA statement below.

## Contributor License Agreement (CLA)

coord-dash is released under the AGPL-3.0, and the maintainer also offers it under commercial
licenses. To keep that possible, every contribution needs this agreement. End **each commit
message** with this line (commit messages, unlike PR descriptions, can't be edited afterwards):

```
CLA: I have read the coord-dash CLA in CONTRIBUTING.md and agree to it for this contribution.
```

(This is a license agreement, not the Developer Certificate of Origin; a `Signed-off-by` line
alone is not enough.)

**The agreement.** By submitting a contribution (code, documentation or other material) to this
project, you agree that:

1. **Origin.** The contribution is your own original work, or you have the right to submit it
   under these terms. If your employer has rights to your work, you have their permission.
2. **License to the maintainer.** You grant Simon Chromec and his successors and assigns
   (including any company he transfers the project to) a perpetual,
   worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify,
   distribute, sublicense and **relicense** your contribution, under the AGPL-3.0, under any other
   open-source license, and under proprietary or commercial licenses.
3. **Patents.** You grant the same parties a perpetual, worldwide, royalty-free, irrevocable patent
   license for any of your patent claims that your contribution necessarily infringes, alone or
   combined with the project.
4. **You keep your copyright.** This is a license, not a transfer. You may use your own
   contribution however you like.
5. **Moral rights.** To the extent the law allows, you waive, or agree not to assert, moral rights
   (such as the right to be named or to object to modifications) against the licensees above in a
   way that would prevent them from using the license in point 2. Where such rights can't be
   waived (for example under Swiss or German law), you consent to the uses described here.
6. **Public release.** Your contribution will also be published under the AGPL-3.0, and you are
   happy for your name to appear in the project's history.
7. **No warranty.** You provide the contribution "as is", without warranties or support
   obligations.

If you can't agree to this, please open an issue describing the change instead; the maintainer
may implement it independently.

*This CLA is written in plain language and has not been reviewed by a lawyer.*
