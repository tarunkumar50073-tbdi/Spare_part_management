"""A person who receives a department's reorder / low-stock mail.

A department can have several recipients (name + email), so the mail is
person-wise, not one address per department. The department still carries the
`notify_reorder` flag; when it is on, every active recipient here gets the mail.
"""
from app.extensions import db
from app.models.base import BaseModel


class DepartmentRecipient(BaseModel):
    __tablename__ = "department_recipients"

    department_id = db.Column(db.Integer, db.ForeignKey("departments.id"), nullable=False, index=True)
    name = db.Column(db.String(120), nullable=False)   # person's name
    email = db.Column(db.String(255), nullable=True)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    department = db.relationship("Department", backref=db.backref("recipients", cascade="all, delete-orphan"))

    def to_dict(self):
        return {
            "id": self.id, "department_id": self.department_id,
            "name": self.name, "email": self.email, "is_active": self.is_active,
        }

    def __repr__(self):
        return f"<DepartmentRecipient {self.name} <{self.email}> dept={self.department_id}>"
