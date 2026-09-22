# C06 follow-up and reconciliation view

CWOS v2 stores mail handling and customer-work closure as separate fields in
`WorkFollowUp`. `mailHandling` records triage/draft/send/provider uncertainty;
`customerWork` records the work item's open, active, or closed state. Closing
customer work is rejected until mail handling is terminal (`SENT` or
`DELIVERY_UNKNOWN`). A delivery-unknown result therefore remains visible for
follow-up instead of being presented as a successful close.

Every follow-up carries a source event, work item, next owner, due date, and
evidence references. Corrections require a reason and create a new version;
they do not overwrite the previous mapping. The runtime CAS audit record
provides the reconciliation trail and keeps the update atomic with the v2
command.
