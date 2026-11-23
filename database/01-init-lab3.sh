#!/bin/bash
(

# Sourced by the MySQL image on first initialization of an empty data volume.
for account in order order_query driver dispatch; do
  case "$account" in
    order) password=$ORDER_DB_PASSWORD ;;
    order_query) password=$ORDER_QUERY_DB_PASSWORD ;;
    driver) password=$DRIVER_DB_PASSWORD ;;
    dispatch) password=$DISPATCH_DB_PASSWORD ;;
  esac

  # The values are interpolated into SQL string literals below.
  if [[ ! "$password" =~ ^[A-Za-z0-9_-]{8,}$ ]]; then
    echo "Invalid DB password for $account: use at least 8 letters, digits, underscores or hyphens." >&2
    exit 1
  fi

  schema="lab3_${account}"
  database_user="lab3_${account}_app"
  docker_process_sql <<SQL || exit 1
CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4;
CREATE USER '${database_user}'@'%' IDENTIFIED BY '${password}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
    ON \`${schema}\`.* TO '${database_user}'@'%';
SQL
done

docker_process_sql <<'SQL' || exit 1
SET NAMES utf8mb4;

CREATE TABLE lab3_driver.demo_accounts (
    id VARCHAR(32) PRIMARY KEY,
    role ENUM('passenger', 'driver') NOT NULL,
    display_name VARCHAR(80) NOT NULL
);

INSERT INTO lab3_driver.demo_accounts (id, role, display_name) VALUES
    ('passenger-1', 'passenger', '乘客一'),
    ('passenger-2', 'passenger', '乘客二'),
    ('driver-1', 'driver', '司机一'),
    ('driver-2', 'driver', '司机二');
SQL
) || exit $?
