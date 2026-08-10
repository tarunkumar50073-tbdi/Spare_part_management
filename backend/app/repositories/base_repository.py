"""Generic repository implementing common CRUD operations (Repository Pattern).

Concrete repositories extend this with entity-specific queries, keeping
SQLAlchemy/query concerns out of the service layer.
"""
from app.extensions import db
from app.utils.db_tx import maybe_commit


class BaseRepository:
    model = None

    def get_by_id(self, id_):
        return self.model.query.get(id_)

    def get_all(self):
        return self.model.query

    def create(self, **kwargs):
        instance = self.model(**kwargs)
        db.session.add(instance)
        maybe_commit()
        return instance

    def update(self, instance, **kwargs):
        for key, value in kwargs.items():
            if hasattr(instance, key):
                setattr(instance, key, value)
        maybe_commit()
        return instance

    def delete(self, instance):
        db.session.delete(instance)
        maybe_commit()

    def save(self, instance):
        db.session.add(instance)
        maybe_commit()
        return instance
