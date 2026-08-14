from pathlib import Path

path = Path("packages/imports/src/notion-cwos.ts")
text = path.read_text()

old_accounts = '''        accountNames.set(normalized, legacySourceId);
        accountSourceIds.add(legacySourceId);
        accounts.push({
          id: id("account", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          name,
          normalizedName: normalized,
          kinds: classifyAccountKind(text(row.properties, ["구분", "유형"])),
          status: mapAccountStatus(text(row.properties, ["관계상태", "상태"])),
          ...(text(row.properties, ["담당자", "주요 담당자"]) ? { primaryContactName: text(row.properties, ["담당자", "주요 담당자"]) } : {}),
          ...(text(row.properties, ["대표 이메일", "이메일"]) ? { primaryEmail: text(row.properties, ["대표 이메일", "이메일"]) } : {}),
          ...(text(row.properties, ["대표 연락처", "전화", "연락처"]) ? { primaryPhone: text(row.properties, ["대표 연락처", "전화", "연락처"]) } : {}),
          ...(dateValue(row.properties, ["date:최근 연락일:start", "최근 연락일"]) ? { recentContactDate: dateValue(row.properties, ["date:최근 연락일:start", "최근 연락일"]) } : {}),
          ...(dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]) ? { nextContactDate: dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]) } : {}),
        });'''
new_accounts = '''        accountNames.set(normalized, legacySourceId);
        accountSourceIds.add(legacySourceId);
        const primaryContactName = text(row.properties, ["담당자", "주요 담당자"]);
        const primaryEmail = text(row.properties, ["대표 이메일", "이메일"]);
        const primaryPhone = text(row.properties, ["대표 연락처", "전화", "연락처"]);
        const recentContactDate = dateValue(row.properties, ["date:최근 연락일:start", "최근 연락일"]);
        const nextContactDate = dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]);
        accounts.push({
          id: id("account", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          name,
          normalizedName: normalized,
          kinds: classifyAccountKind(text(row.properties, ["구분", "유형"])),
          status: mapAccountStatus(text(row.properties, ["관계상태", "상태"])),
          ...(primaryContactName !== undefined ? { primaryContactName } : {}),
          ...(primaryEmail !== undefined ? { primaryEmail } : {}),
          ...(primaryPhone !== undefined ? { primaryPhone } : {}),
          ...(recentContactDate !== undefined ? { recentContactDate } : {}),
          ...(nextContactDate !== undefined ? { nextContactDate } : {}),
        });'''
if old_accounts not in text and new_accounts not in text:
    raise SystemExit("account import block not found")
text = text.replace(old_accounts, new_accounts)

old_projects = '''        projectKeys.set(key, legacySourceId);
        projectSourceIds.add(legacySourceId);
        const proposed = integerMoney(row.properties, ["제안금액", "예상 매출"]);
        engagements.push({
          id: id("engagement", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          projectKey: key,
          name,
          stage: mapProjectStage(text(row.properties, ["상태", "단계"])),
          ...(text(row.properties, ["중요도"]) ? { priority: text(row.properties, ["중요도"]) } : {}),
          ...(dateValue(row.properties, ["date:시작일:start", "시작일"]) ? { startDate: dateValue(row.properties, ["date:시작일:start", "시작일"]) } : {}),
          ...(dateValue(row.properties, ["date:종료일:start", "종료일"]) ? { targetDate: dateValue(row.properties, ["date:종료일:start", "종료일"]) } : {}),
          ...(text(row.properties, ["다음 행동"]) ? { nextAction: text(row.properties, ["다음 행동"]) } : {}),
          ...(text(row.properties, ["제안제품"]) ? { proposedProducts: text(row.properties, ["제안제품"]) } : {}),
          ...(proposed !== undefined ? { proposedAmountKrw: proposed.toString() } : {}),
          accountSourceIds: accountIds,
          partnerSourceIds: partnerIds,
          artifactRefs: {
            quote: stringArray(row.properties, ["견적서"]),
            proposal: stringArray(row.properties, ["제안서"]),
            contract: stringArray(row.properties, ["계약서"]),
            completion: stringArray(row.properties, ["완료보고서"]),
          },
        });'''
new_projects = '''        projectKeys.set(key, legacySourceId);
        projectSourceIds.add(legacySourceId);
        const proposed = integerMoney(row.properties, ["제안금액", "예상 매출"]);
        const priority = text(row.properties, ["중요도"]);
        const startDate = dateValue(row.properties, ["date:시작일:start", "시작일"]);
        const targetDate = dateValue(row.properties, ["date:종료일:start", "종료일"]);
        const nextAction = text(row.properties, ["다음 행동"]);
        const proposedProducts = text(row.properties, ["제안제품"]);
        engagements.push({
          id: id("engagement", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          projectKey: key,
          name,
          stage: mapProjectStage(text(row.properties, ["상태", "단계"])),
          ...(priority !== undefined ? { priority } : {}),
          ...(startDate !== undefined ? { startDate } : {}),
          ...(targetDate !== undefined ? { targetDate } : {}),
          ...(nextAction !== undefined ? { nextAction } : {}),
          ...(proposedProducts !== undefined ? { proposedProducts } : {}),
          ...(proposed !== undefined ? { proposedAmountKrw: proposed.toString() } : {}),
          accountSourceIds: accountIds,
          partnerSourceIds: partnerIds,
          artifactRefs: {
            quote: stringArray(row.properties, ["견적서"]),
            proposal: stringArray(row.properties, ["제안서"]),
            contract: stringArray(row.properties, ["계약서"]),
            completion: stringArray(row.properties, ["완료보고서"]),
          },
        });'''
if old_projects not in text and new_projects not in text:
    raise SystemExit("project import block not found")
text = text.replace(old_projects, new_projects)

old_activities = '''        activities.push({
          id: id("activity", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          activityType: text(row.properties, ["유형", "활동 유형"]) ?? "메모",
          occurredAt,
          summary,
          ...(text(row.properties, ["결정사항"]) ? { decision: text(row.properties, ["결정사항"]) } : {}),
          ...(text(row.properties, ["다음 행동"]) ? { nextAction: text(row.properties, ["다음 행동"]) } : {}),
          ...(dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]) ? { nextContactDate: dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]) } : {}),
          accountSourceIds: accountIds,
          projectSourceIds: projectIds,
          attachmentRefs: stringArray(row.properties, ["첨부"]),
        });'''
new_activities = '''        const decision = text(row.properties, ["결정사항"]);
        const nextAction = text(row.properties, ["다음 행동"]);
        const nextContactDate = dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]);
        activities.push({
          id: id("activity", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          activityType: text(row.properties, ["유형", "활동 유형"]) ?? "메모",
          occurredAt,
          summary,
          ...(decision !== undefined ? { decision } : {}),
          ...(nextAction !== undefined ? { nextAction } : {}),
          ...(nextContactDate !== undefined ? { nextContactDate } : {}),
          accountSourceIds: accountIds,
          projectSourceIds: projectIds,
          attachmentRefs: stringArray(row.properties, ["첨부"]),
        });'''
if old_activities not in text and new_activities not in text:
    raise SystemExit("activity import block not found")
text = text.replace(old_activities, new_activities)

path.write_text(text)
Path("scripts/fix-notion-cwos-optionals.py").unlink()
Path(".github/workflows/cwos-fix-notion-optionals.yml").unlink()
