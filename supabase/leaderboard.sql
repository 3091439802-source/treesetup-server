-- Run once in the Supabase SQL Editor for project isgmdsnwlljbdsycxzom.
-- The Unity client uses the anon/publishable key and calls the RPC below.

create table if not exists public.leaderboard (
    user_id text primary key,
    player_name text not null,
    score integer not null default 0 check (score >= 0),
    updated_at timestamptz not null default now()
);

-- Existing projects may already have a leaderboard table created through the
-- dashboard with only player_name and score. Upgrade that table in place.
alter table public.leaderboard add column if not exists user_id text;
alter table public.leaderboard add column if not exists updated_at timestamptz not null default now();
create unique index if not exists leaderboard_user_id_key on public.leaderboard (user_id);

-- Expose the calculated position instead of persisting a rank that becomes
-- stale whenever another account improves its score.
create or replace view public.leaderboard_rankings
with (security_invoker = true)
as
select
    user_id,
    player_name,
    score,
    dense_rank() over (order by score desc) as rank,
    updated_at
from public.leaderboard;

alter table public.leaderboard enable row level security;

grant usage on schema public to anon;
grant select on public.leaderboard to anon;
grant select on public.leaderboard_rankings to anon;

drop policy if exists "Public leaderboard read" on public.leaderboard;
create policy "Public leaderboard read"
    on public.leaderboard for select to anon using (true);

create or replace function public.upsert_leaderboard(
    p_user_id text,
    p_name text,
    p_score integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id text;
    v_name text;
begin
    -- ---- 服务端入参校验（防刷/防脏数据）----
    -- 客户端持有 anon key 即可直接调用本 RPC，因此所有入参都不可信：
    --  1) user_id / name 必须非空、限长；name 先剔除控制字符再去首尾空白，
    --     再按 32 字符截断，防止昵称里塞换行/不可见字符污染排行榜显示。
    --  2) score 只接受 [0, 10000000]，负数或超大值直接报错而不是静默钳制，
    --     避免畸形请求/刷分数据进入排行榜。
    v_user_id := trim(coalesce(p_user_id, ''));
    if v_user_id = '' then
        raise exception 'upsert_leaderboard: p_user_id must not be empty';
    end if;
    if length(v_user_id) > 200 then
        raise exception 'upsert_leaderboard: p_user_id exceeds 200 characters';
    end if;

    v_name := trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g'));
    if v_name = '' then
        raise exception 'upsert_leaderboard: p_name must not be empty';
    end if;
    v_name := left(v_name, 32);

    if p_score is null or p_score < 0 or p_score > 10000000 then
        raise exception 'upsert_leaderboard: p_score must be within [0, 10000000]';
    end if;

    -- 同 user_id 冲突时只允许"成绩提高"（取较大值）；低分/重复提交不刷新
    -- updated_at。昵称仍允许本人更新（同名同分不写），避免占位/反复刷写。
    insert into public.leaderboard (user_id, player_name, score, updated_at)
    values (v_user_id, v_name, p_score, now())
    on conflict (user_id) do update set
        player_name = excluded.player_name,
        score = greatest(public.leaderboard.score, excluded.score),
        updated_at = now()
    where excluded.score > public.leaderboard.score
       or excluded.player_name is distinct from public.leaderboard.player_name;

    -- 已知限制：anon key 下 SQL 无法识别请求来自哪个登录账号（当前 user_id 由
    -- 客户端自行拼装），纯 SQL 无法彻底防"冒用他人 user_id"。彻底方案：客户端
    -- 改用 Supabase Auth 登录，p_user_id 由服务端 auth.uid() 签发后再做绑定校验。
end;
$$;

revoke all on function public.upsert_leaderboard(text, text, integer) from public;
grant execute on function public.upsert_leaderboard(text, text, integer) to anon;

-- Required for clients subscribed through Supabase Realtime to receive score
-- submissions from other accounts.
do $$
begin
    alter publication supabase_realtime add table public.leaderboard;
exception
    when duplicate_object then null;
end $$;

-- Make the new RPC available to PostgREST immediately.
notify pgrst, 'reload schema';

-- ============================================================
-- 头像升级（2026-09-26）：排行榜要显示"对方设置的头像"
--
-- 客户端改动：LeaderboardGroupPage 每行左侧加了头像槽；提交成绩时顺带带 p_avatar。
--   · 头像值 = 本机设置里选的头像编号 "1".."4"（Resources/AvatarPick/头像1..四），
--     或者第三方登录（微信/QQ）带回来的 http(s) 头像地址。
--   · 兼容性：客户端先带 p_avatar 提交，后端不认（404）就退回原三参数再提交一次；
--     查询时没这一列/这个视图列，就退回默认头像，不会报错。
--
-- 这一段是"追加升级"脚本，需要在 Supabase SQL Editor 里执行一次才生效
-- （项目 isgmdsnwlljbdsycxzom）。没执行也一切照旧，头像只是显示成默认头像。
-- ============================================================

alter table public.leaderboard add column if not exists avatar text;

-- 视图加 avatar 列。create or replace view 只能"在末尾追加"列，
-- 所以这里保持原 user_id / player_name / score / rank / updated_at 的顺序不动。
create or replace view public.leaderboard_rankings
with (security_invoker = true)
as
select
    user_id,
    player_name,
    score,
    dense_rank() over (order by score desc) as rank,
    updated_at,
    avatar
from public.leaderboard;

grant select on public.leaderboard_rankings to anon;

-- 旧的 3 参数版本换成 4 参数版本。p_avatar 带默认值，所以老客户端只传 3 个参数
-- 也照样能调；先 drop 是为了避免 PostgREST 在重载之间挑不出函数（PGRST203）。
drop function if exists public.upsert_leaderboard(text, text, integer);

create or replace function public.upsert_leaderboard(
    p_user_id text,
    p_name text,
    p_score integer,
    p_avatar text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id text;
    v_name text;
    v_avatar text;
begin
    -- ---- 服务端入参校验（防刷/防脏数据）----
    -- 客户端持有 anon key 即可直接调用本 RPC，因此所有入参都不可信：
    --  1) user_id / name 必须非空、限长；name 先剔除控制字符再去首尾空白，
    --     再按 32 字符截断，防止昵称里塞换行/不可见字符污染排行榜显示。
    --  2) score 只接受 [0, 10000000]，负数或超大值直接报错而不是静默钳制，
    --     避免畸形请求/刷分数据进入排行榜。
    v_user_id := trim(coalesce(p_user_id, ''));
    if v_user_id = '' then
        raise exception 'upsert_leaderboard: p_user_id must not be empty';
    end if;
    if length(v_user_id) > 200 then
        raise exception 'upsert_leaderboard: p_user_id exceeds 200 characters';
    end if;

    v_name := trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g'));
    if v_name = '' then
        raise exception 'upsert_leaderboard: p_name must not be empty';
    end if;
    v_name := left(v_name, 32);

    if p_score is null or p_score < 0 or p_score > 10000000 then
        raise exception 'upsert_leaderboard: p_score must be within [0, 10000000]';
    end if;

    --  3) avatar 只收两类值：本机头像编号 '1'..'4'，或 http(s) 头像地址（<=512 字符）。
    --     头像属于附加信息，不认识的脏值一律当作"没设置"丢掉，不让头像字段
    --     把整次成绩上传搞失败。
    v_avatar := nullif(trim(coalesce(p_avatar, '')), '');
    if v_avatar is not null
       and (length(v_avatar) > 512
            or (v_avatar !~ '^[1-4]$' and v_avatar !~* '^https?://')) then
        v_avatar := null;
    end if;

    -- 同 user_id 冲突时只允许"成绩提高"（取较大值）；低分/重复提交不刷新
    -- updated_at。昵称仍允许本人更新（同名同分不写），避免占位/反复刷写；
    -- 头像同理：只有传了新头像并且和库里不一样时才写，不然改个头像会白刷一次 updated_at。
    insert into public.leaderboard (user_id, player_name, score, avatar, updated_at)
    values (v_user_id, v_name, p_score, v_avatar, now())
    on conflict (user_id) do update set
        player_name = excluded.player_name,
        avatar = coalesce(excluded.avatar, public.leaderboard.avatar),
        score = greatest(public.leaderboard.score, excluded.score),
        updated_at = now()
    where excluded.score > public.leaderboard.score
       or excluded.player_name is distinct from public.leaderboard.player_name
       or (excluded.avatar is not null and excluded.avatar is distinct from public.leaderboard.avatar);

    -- 已知限制：anon key 下 SQL 无法识别请求来自哪个登录账号（当前 user_id 由
    -- 客户端自行拼装），纯 SQL 无法彻底防"冒用他人 user_id"。彻底方案：客户端
    -- 改用 Supabase Auth 登录，p_user_id 由服务端 auth.uid() 签发后再做绑定校验。
end;
$$;

revoke all on function public.upsert_leaderboard(text, text, integer, text) from public;
grant execute on function public.upsert_leaderboard(text, text, integer, text) to anon;

-- Make the upgraded view/RPC available to PostgREST immediately.
notify pgrst, 'reload schema';