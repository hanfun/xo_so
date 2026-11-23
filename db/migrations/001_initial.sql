-- XSKT schema: MySQL 8.0+ / InnoDB. No DROP statements.
CREATE TABLE IF NOT EXISTS provinces (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  region CHAR(2) NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_provinces_region_code (region, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS draws (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  province_id BIGINT UNSIGNED NOT NULL,
  draw_date DATE NOT NULL,
  ticket_type VARCHAR(100) NOT NULL DEFAULT '',
  source_url TEXT NULL,
  collected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_draws_province_date (province_id, draw_date),
  KEY idx_draw_date (draw_date),
  CONSTRAINT fk_draws_province FOREIGN KEY (province_id)
    REFERENCES provinces(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS prize_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  draw_id BIGINT UNSIGNED NOT NULL,
  prize_code VARCHAR(12) NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  number VARCHAR(8) NOT NULL,
  UNIQUE KEY uq_prize_draw_tier_position (draw_id, prize_code, position),
  KEY idx_prize_number (number),
  KEY idx_prize_code_number (prize_code, number),
  CONSTRAINT fk_prizes_draw FOREIGN KEY (draw_id)
    REFERENCES draws(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One normalized and original provider payload per day, for audit and UI retrieval.
CREATE TABLE IF NOT EXISTS source_snapshots (
  draw_date DATE NOT NULL PRIMARY KEY,
  source_url TEXT NULL,
  raw_json JSON NULL,
  report_json JSON NOT NULL,
  provider_count INT UNSIGNED NULL,
  status VARCHAR(40) NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ML metadata: generated predictions do not overwrite the historical draw.
CREATE TABLE IF NOT EXISTS model_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  model_key VARCHAR(100) NOT NULL,
  version VARCHAR(100) NOT NULL,
  description TEXT NULL,
  parameters_json JSON NULL,
  training_start DATE NULL,
  training_end DATE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_model_version (model_key, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS features (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  province_id BIGINT UNSIGNED NOT NULL,
  feature_date DATE NOT NULL,
  cutoff_date DATE NOT NULL,
  feature_key VARCHAR(120) NOT NULL,
  feature_value DOUBLE NOT NULL,
  computed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_feature (province_id, feature_date, cutoff_date, feature_key),
  CONSTRAINT fk_feature_province FOREIGN KEY (province_id)
    REFERENCES provinces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS predictions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  model_version_id BIGINT UNSIGNED NOT NULL,
  province_id BIGINT UNSIGNED NOT NULL,
  target_date DATE NOT NULL,
  prediction_type VARCHAR(40) NOT NULL,
  predicted_value VARCHAR(16) NOT NULL,
  confidence DOUBLE NULL,
  training_cutoff DATE NOT NULL,
  generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  metadata_json JSON NULL,
  UNIQUE KEY uq_prediction (model_version_id, province_id, target_date, prediction_type, predicted_value),
  KEY idx_prediction_target (target_date),
  CONSTRAINT fk_prediction_model FOREIGN KEY (model_version_id)
    REFERENCES model_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_prediction_province FOREIGN KEY (province_id)
    REFERENCES provinces(id) ON DELETE RESTRICT,
  CONSTRAINT chk_prediction_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT chk_prediction_cutoff CHECK (training_cutoff < target_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS prediction_evaluations (
  prediction_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  actual_draw_id BIGINT UNSIGNED NOT NULL,
  is_hit BOOLEAN NOT NULL,
  evaluation_json JSON NULL,
  evaluated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_eval_prediction FOREIGN KEY (prediction_id)
    REFERENCES predictions(id) ON DELETE CASCADE,
  CONSTRAINT fk_eval_draw FOREIGN KEY (actual_draw_id)
    REFERENCES draws(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
