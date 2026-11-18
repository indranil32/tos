-- Two roles: the owner runs migrations; the app role never owns tables, so row-level security always applies.
CREATE ROLE tos_owner LOGIN PASSWORD 'owner_dev_only';
CREATE ROLE tos_app LOGIN PASSWORD 'app_dev_only';
CREATE DATABASE tos OWNER tos_owner;
