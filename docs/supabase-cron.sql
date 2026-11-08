-- 같이 일어나요 — 오래된 기록 자동 정리 (supabase-care.sql 다음에 실행)
-- 매일 새벽 04:10(한국 시각 = UTC 19:10)에 private.purge_old() 실행.
-- pg_cron을 켤 수 없으면 이 파일은 건너뛰고, OPERATIONS.md대로 한 달에 한 번 select private.purge_old(); 를 실행하세요.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('gachi-purge-old', '10 19 * * *', 'select private.purge_old()');
