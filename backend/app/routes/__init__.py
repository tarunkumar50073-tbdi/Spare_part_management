"""Registers all versioned API blueprints onto the Flask app."""


def register_routes(app):
    from app.routes.supplier_routes import bp as supplier_bp
    from app.routes.part_routes import bp as part_bp
    from app.routes.srv_routes import bp as srv_bp
    from app.routes.store_dashboard_routes import bp as store_dashboard_bp
    from app.routes.finished_good_routes import bp as finished_good_bp
    from app.routes.bom_routes import bp as bom_bp
    from app.routes.forecast_routes import bp as forecast_bp
    from app.routes.stock_count_routes import bp as stock_count_bp
    from app.routes.rack_bin_routes import bp as rack_bin_bp
    from app.routes.erp_routes import bp as erp_bp
    from app.routes.store_stock_routes import bp as store_stock_bp
    from app.routes.report_routes import bp as report_bp
    from app.routes.holding_routes import bp as holding_bp
    from app.routes.notification_routes import bp as notification_bp
    from app.routes.audit_routes import bp as audit_bp
    from app.routes.live_stock_routes import bp as live_stock_bp
    from app.routes.quarterly_inventory_routes import bp as quarterly_inventory_bp
    from app.routes.inventory_overview_routes import bp as inventory_overview_bp
    from app.routes.supplier_vehicle_routes import bp as supplier_vehicle_bp
    from app.routes.supplier_window_schedule_routes import bp as supplier_window_schedule_bp
    from app.routes.milkrun_group_routes import bp as milkrun_group_bp
    from app.routes.production_receipt_routes import bp as production_receipt_bp
    from app.routes.erp_gap_routes import bp as erp_gap_bp
    from app.routes.auth_routes import bp as auth_bp
    from app.routes.store_routes import bp as store_bp
    from app.routes.spare_stock_routes import bp as spare_stock_bp
    from app.routes.department_routes import bp as department_bp
    from app.routes.rgp_routes import bp as rgp_bp
    from app.routes.receiving_register_routes import bp as receiving_register_bp
    from app.routes.gate_routes import bp as gate_bp

    app.register_blueprint(supplier_bp)
    app.register_blueprint(part_bp)
    app.register_blueprint(srv_bp)
    app.register_blueprint(store_dashboard_bp)
    app.register_blueprint(finished_good_bp)
    app.register_blueprint(bom_bp)
    app.register_blueprint(forecast_bp)
    app.register_blueprint(stock_count_bp)
    app.register_blueprint(rack_bin_bp)
    app.register_blueprint(erp_bp)
    app.register_blueprint(store_stock_bp)
    app.register_blueprint(report_bp)
    app.register_blueprint(holding_bp)
    app.register_blueprint(notification_bp)
    app.register_blueprint(audit_bp)
    app.register_blueprint(live_stock_bp)
    app.register_blueprint(quarterly_inventory_bp)
    app.register_blueprint(inventory_overview_bp)
    app.register_blueprint(supplier_vehicle_bp)
    app.register_blueprint(supplier_window_schedule_bp)
    app.register_blueprint(milkrun_group_bp)
    app.register_blueprint(production_receipt_bp)
    app.register_blueprint(erp_gap_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(store_bp)
    app.register_blueprint(spare_stock_bp)
    app.register_blueprint(department_bp)
    app.register_blueprint(rgp_bp)
    app.register_blueprint(receiving_register_bp)
    app.register_blueprint(gate_bp)

    @app.route("/api/v1/health", methods=["GET"])
    def health_check():
        from app.utils.response import success_response
        return success_response({"status": "UP"}, "Part Store API is running")
