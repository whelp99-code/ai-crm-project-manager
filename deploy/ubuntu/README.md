# AI-CRM+PM — Ubuntu 구축 가이드

## 배포 대상

- 프로젝트: `AI-CRM+PM`
- Worker 이름: `AI-CRM+PM`
- 제품: `JM AI-Native Customer Work OS v2.5.0`
- 기본 경로: `/home/jm/orca/projects/AI-CRM+PM`
- 소스 브랜치: `feat/cwos-v2.5-ai-managed-input`

## 구성

```text
Mac Browser
    │ SSH tunnel
    ▼
Ubuntu 127.0.0.1:3000
    │
    ▼
Next.js Web ── internal Bearer token ──> Fastify API
                                            │
                         ┌──────────────────┼──────────────────┐
                         ▼                  ▼                  ▼
                  PostgreSQL 16          Worker          Model Gateway
                  RLS + Audit          background        optional/offline
```

PostgreSQL과 API는 Ubuntu 외부에 포트를 공개하지 않습니다. Web만 Ubuntu localhost에 바인딩하고 Mac에서 SSH 터널로 접속합니다.

## 새 서버에서 한 번에 구축

GitHub SSH 인증이 준비된 Ubuntu에서 실행합니다.

```bash
mkdir -p /home/jm/orca/projects
cd /home/jm/orca/projects

git clone --branch feat/cwos-v2.5-ai-managed-input \
  git@github.com:whelp99-code/ai-crm-project-manager.git \
  AI-CRM+PM

cd AI-CRM+PM
bash deploy/ubuntu/scripts/install.sh
```

이미 Clone된 프로젝트를 정확한 브랜치로 동기화하면서 구축하려면:

```bash
bash deploy/ubuntu/bootstrap.sh
```

`bootstrap.sh`는 수정 중인 파일이 있으면 먼저 Git stash에 보존합니다.

## Mac에서 접속

Ubuntu에서 출력된 서버 IP를 사용합니다.

```bash
ssh -L 3000:127.0.0.1:3000 jm@UBUNTU_SERVER_IP
```

브라우저에서:

```text
http://localhost:3000/capture
http://localhost:3000/review
http://localhost:3000/today
```

## 주요 화면

- `/capture`: 메일·메모·회의 내용을 한 번 입력
- `/review`: AI가 확신하지 못한 항목만 확인
- `/today`: 기한·미수·미지급·저마진·범위 변경 확인
- `/v2`: Runtime과 릴리스 준비 상태

## 운영 명령

모든 명령은 프로젝트 루트에서 실행합니다.

```bash
# 상태
sudo docker compose --env-file deploy/ubuntu/.env -f deploy/ubuntu/compose.yml ps

# 로그
sudo docker compose --env-file deploy/ubuntu/.env -f deploy/ubuntu/compose.yml logs -f --tail=200 api web worker

# 재시작
sudo docker compose --env-file deploy/ubuntu/.env -f deploy/ubuntu/compose.yml restart api web worker

# 검증
bash deploy/ubuntu/scripts/verify.sh

# 백업
bash deploy/ubuntu/scripts/backup.sh

# 중지
sudo docker compose --env-file deploy/ubuntu/.env -f deploy/ubuntu/compose.yml down
```

## 복구

복구는 현재 데이터베이스를 교체하는 파괴적 작업이므로 명시적 확인이 필요합니다.

```bash
RESTORE_CONFIRM=RESTORE_AI_CRM_PM \
  bash deploy/ubuntu/scripts/restore.sh \
  deploy/ubuntu/backups/ai-crm-pm-YYYYMMDDTHHMMSSZ.dump
```

## 환경파일

최초 구축 시 `deploy/ubuntu/.env`가 자동 생성되고 권한은 `600`으로 설정됩니다. 실제 비밀번호와 API 키를 Git에 커밋하지 마십시오.

AI 모델은 기본적으로 비활성화된 fail-closed 상태입니다. 실제 모델을 연결하려면 `.env`에 다음 값을 입력한 뒤 API를 재시작합니다.

```text
MODEL_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=...
```

```bash
sudo docker compose --env-file deploy/ubuntu/.env -f deploy/ubuntu/compose.yml up -d --force-recreate api
```

## 현재 운영 경계

이 구성은 내부 Shadow Pilot과 실사용 검증을 위한 배포입니다.

- 외부 Gmail·Calendar·Notion·Drive OAuth는 별도 연결 필요
- 고객 자동 발송과 지급 자동 실행은 비활성화
- 금액·계약·범위 변경은 Human Approval 유지
- Web을 인터넷에 직접 노출하지 않음
- Production 전환 전 실제 백업·복구 및 장기간 안정성 검증 필요
