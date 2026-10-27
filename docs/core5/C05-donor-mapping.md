# C05 donor mapping and relation-policy decision

This checkout remains the owner of Customer Work OS data and authorization.
The read-only donor scan found Sangfor-oriented packages for identity,
integration, approval, audit, intent graph, PM, and store concerns under the
adjacent `whelp99-code-sangfor-engineer-mcp` workspace. The adjacent BLRO
workspace is a website workspace. Their schemas and persistence code are not
copied into this repository.

| Concern | CWOS v2 owner | Donor use in C05 |
| --- | --- | --- |
| customer/work item identity | `packages/domain/src/customer-work-os-v2/identity.ts` and platform state | names and concepts only; IDs stay local |
| mail source and work link | v2 inbox plus additive mail migration | source locator contrast only |
| authorization | `packages/governance` and policy engine | no OpenFGA runtime dependency |
| audit/evidence | v2 hash-chained runtime and existing governance audit | compare terminology only |

OpenFGA is shadow-only in this phase: a future relation tuple may be compared
to the existing membership/policy decision, but it cannot authorize, widen,
or replace the current policy revision. No OpenFGA package, client, or schema
is activated by C05.

The acceptance boundary is therefore an ID-level adapter and a documented
contrast, not a full donor schema copy. Any future adoption requires a new
policy revision and security tests before it can affect a request.
