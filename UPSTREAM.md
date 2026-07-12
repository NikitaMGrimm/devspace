# Fork Maintenance

This repository is the maintained `NikitaMGrimm/devspace` fork of
[`Waishnav/devspace`](https://github.com/Waishnav/devspace). Production builds
in `NikitaMGrimm/personal-vps` pin a full commit from this fork rather than
applying deployment-time patches.

Keep these remotes in local clones:

```text
origin   https://github.com/NikitaMGrimm/devspace.git
upstream https://github.com/Waishnav/devspace.git
```

To incorporate upstream changes, fetch both remotes, create a topic branch from
the fork's `main`, and merge or rebase the desired upstream revision. Run the
typecheck, complete test suite, and build before merging. Resolve conflicts in
the fork as normal source changes; do not recreate compiled patch files in the
deployment repository.

After the fork update is merged, update the full `devspace_revision` SHA in
`NikitaMGrimm/personal-vps`, validate its image build, and deploy that pin. A
rollback restores the earlier SHA and rebuilds the image.
